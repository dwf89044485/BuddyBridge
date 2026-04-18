# BuddyBridge SSE 转换体系：问题诊断与修复方案

## 一、SSE 在 BuddyBridge 中的位置

```
CLI 子进程 stdout (NDJSON) → Provider (转换器) → ReadableStream<string> (SSE) → 对话引擎 (consumeStream)
```

- **生产端**：Provider 把 CLI 返回的消息转成 SSE 格式的字符串流
- **消费端**：对话引擎的 `consumeStream()` 逐行解析 SSE，驱动对话逻辑
- **格式契约**：`SSEEvent { type: SSEEventType; data: string }`，定义在 `host.ts`

---

## 二、双层 JSON 格式详解

### 2.1 格式定义

BuddyBridge 的 SSE 消息格式：

```
data: {"type":"text","data":"你好"}\n
data: {"type":"tool_use","data":"{\"id\":\"abc\",\"name\":\"Read\"}"}\n
data: {"type":"result","data":"{\"session_id\":\"s1\",\"usage\":{...}}"}\n
```

外层 `{type, data}`，`data` 字段**始终是 string**：
- text/error 事件：data 就是纯文本
- 结构化事件：data 是 `JSON.stringify` 后的字符串（需二次 parse）

### 2.2 生产端：sseEvent() 函数

```typescript
// sse-utils.ts
export function sseEvent(type: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}
```

工作流程：
1. data 是字符串 → 直接用作 payload
2. data 是对象 → 先 `JSON.stringify` 成字符串
3. 构造 `{type, data: payload}` 对象
4. 整体 `JSON.stringify` 一次
5. 拼上 `data: ` 前缀和 `\n` 后缀

### 2.3 消费端：consumeStream() 函数

```typescript
// conversation-engine.ts:331-344
const lines = value.split('\n');
for (const line of lines) {
  if (!line.startsWith('data: ')) continue;
  let event: SSEEvent;
  try {
    event = JSON.parse(line.slice(6));  // 第一次 parse
  } catch { continue; }

  switch (event.type) {
    case 'text':
      currentText += event.data;  // 直接用字符串，不二次 parse
      break;
    case 'tool_use':
      const toolData = JSON.parse(event.data);  // 第二次 parse
      break;
    case 'result':
      const resultData = JSON.parse(event.data);  // 第二次 parse
      break;
    // ...
  }
}
```

### 2.4 双层 vs 业界实践

| 实现方 | data 字段格式 | 类型路由方式 |
|--------|-------------|-------------|
| OpenAI API | 单层 JSON 对象 | 无（所有事件同格式） |
| Anthropic Claude API | 单层 JSON 对象 | SSE `event:` 字段 |
| Vercel AI SDK | 单层 JSON 对象 | JSON 内 `type` 字段 |
| **BuddyBridge** | **双层 JSON** | JSON 内 `type` 字段 + `data` 永远为 string |

**结论**：双层不是业界典型做法。但消费端已深度依赖双层格式，改单层代价高、风险大。**保持格式不变，统一生产方式**是当前最务实的选择。

---

## 三、两套 SSE 转换器的差异

### 3.1 存在原因

| 路线 | 输入来源 | 转换器 | 位置 |
|------|---------|--------|------|
| SDK 路线（普通 Provider） | SDK `query()` 返回的 `SDKMessage` 类型化对象 | `handleMessage()` | `llm-provider.ts:608` / `codebuddysdk-provider.ts:324` |
| 持久化路线 | stdout 原始 NDJSON 解析出的 `CliMessage` 泛型对象 | `cliMessageToSseString()` | `process.ts:566` |

两套转换器存在是因为**输入格式不同**，不是主动选择维护两套。

### 3.2 功能差异详表

| 消息类型 | SDK `handleMessage()` | 持久化 `cliMessageToSseString()` | 差异 |
|---------|----------------------|----------------------------------|------|
| **stream_event text_delta** | `sseEvent('text', delta.text)` | 手拼 `data: {"type":"text","data":...}\n` | 持久化没用 `sseEvent()` |
| **stream_event tool_use** | `sseEvent('tool_use', {id, name, input})` | 手拼 `data: {"type":"tool_use",...}\n` | 同上 |
| **assistant text 块** | 捕获到 `lastAssistantText`，**不发出 SSE** | **直接作为 `text` SSE 发出** | **导致文本重复输出** |
| **assistant tool_use 块** | 发 `tool_use` SSE 事件 | **完全忽略** | **丢失工具调用信息** |
| **user tool_result** | `sseEvent('tool_result', {...})` | 手拼，但 data 字段格式不同 | 格式可能不一致 |
| **system init** | `sseEvent('status', {session_id, model})` | 手拼，额外带 `_internal: true, persistent_process: true` | 多了内部标记 |
| **result success** | `sseEvent('result', {session_id, usage, cost_usd})` | 手拼，字段名有差异（`cost_usd` vs `total_cost_usd`） | **字段名不一致** |
| **result error** | `sseEvent('error', errors)` | 手拼 | 格式可能不一致 |
| **error** | `sseEvent('error', msg.error)` | 手拼 | 格式可能不一致 |

### 3.3 关键问题汇总

#### 问题 1：assistant 消息处理导致文本重复

**原因**：`stream_event` 的 text_delta 已经逐字发过一遍，`assistant` 消息又把完整文本发了一遍。

**SDK 路线的做法**：`handleMessage()` 只把 text 捕获到 `lastAssistantText`（用于 auth 错误检测），不通过 SSE 发出。

**持久化路线的做法**：`cliMessageToSseString()` 把 assistant 的 text 直接作为 `type: 'text'` SSE 发出。

**影响**：用户看到文字输出两遍。

#### 问题 2：assistant 中 tool_use 块丢失

**原因**：`cliMessageToSseString()` 的 `assistant` 分支只提取 text，跳过了 tool_use 块。

**影响**：如果 CLI 没有通过 `stream_event` 发出 tool_use（某些场景下可能只有 assistant 消息里有），工具调用信息会丢失。

#### 问题 3：result 消息字段名不一致

SDK 路线发 `cost_usd`，持久化路线发 `total_cost_usd`。消费端可能只认其中一个。

#### 问题 4：没有 StreamState

持久化路线没有 `hasReceivedResult` / `hasStreamedText` / `lastAssistantText` 状态追踪，导致：
- 崩溃时无法判断 result 是否已收到（无法抑制传输噪声）
- 无法检测部分输出 + 崩溃（无法区分完整响应 vs 截断响应）
- 无法利用 `lastAssistantText` 做 auth 错误分类

---

## 四、官方 SDK 的处理方式

### 4.1 Anthropic `@anthropic-ai/claude-agent-sdk`

- `stream_event` 和 `assistant` 都原样抛给消费者，**不做去重**
- 通过 `includePartialMessages` 控制：`false` 只抛 `assistant`，`true` 两个都抛
- 没有 StreamState，去重是消费者责任
- 错误处理：捕获 stderr 尾部（500 字符），进程退出时设 close reason

### 4.2 Tencent `@tencent-ai/agent-sdk`

- 逻辑完全一致，同样不做去重
- 同样通过 `includePartialMessages` 控制
- 同样没有 StreamState
- 额外有 `Stream.reset()` 方法支持重新迭代

### 4.3 对 BuddyBridge 的启示

**去重是 BuddyBridge 自己的责任**。SDK 路线的 `handleMessage()` 已经正确处理了（assistant text 不发出），但持久化路线没有。这是待修复的核心问题。

---

## 五、NDJSON 安全性：U+2028/U+2029 问题

### 5.1 问题描述

U+2028（Line Separator）和 U+2029（Paragraph Separator）在 JSON 规范中是合法字符，`JSON.stringify` 不会转义它们。但在 JavaScript 中它们是行终止符，会导致 NDJSON 按行切割时把一条消息切成两条，解析崩溃。

### 5.2 官方解法

Anthropic 官方 CLI 有 `ndjsonSafeStringify` 函数：

```typescript
function ndjsonSafeStringify(obj: unknown): string {
  return JSON.stringify(obj).replace(/\u2028|\u2029/g, (ch) =>
    ch === '\u2028' ? '\\u2028' : '\\u2029'
  );
}
```

### 5.3 BuddyBridge 现状

`NdjsonParser` 没有此防护。AI 输出文本中可能出现这两个字符，导致持久化路线的 NDJSON 解析崩溃。

---

## 六、修复方案

### 修复 1：统一用 `sseEvent()` 生成所有 SSE 输出

**目标**：`cliMessageToSseString()` 内部所有手拼 JSON 的地方替换为 `sseEvent()` 调用。

**改动位置**：`process.ts:566-692` 的 `cliMessageToSseString()` 函数

**改动示例**：

```typescript
// 之前
return `data: ${JSON.stringify({ type: 'text', data: event.delta.text })}\n`;

// 之后
return sseEvent('text', event.delta.text);
```

**收益**：
- 格式与 SDK 路线完全一致
- 特殊字符（引号、换行等）自动正确转义
- 未来格式调整只改 `sseEvent()` 一处

### 修复 2：assistant 消息处理对齐 SDK 语义

**目标**：持久化路线的 assistant 处理和 SDK 路线对齐。

**具体改动**：

2a. 给 `PersistentProcess` 增加 `StreamState`：

```typescript
// process.ts
interface StreamState {
  hasReceivedResult: boolean;
  hasStreamedText: boolean;
  lastAssistantText: string;
}

private streamState: StreamState = {
  hasReceivedResult: false,
  hasStreamedText: false,
  lastAssistantText: '',
};
```

2b. 在 `forwardToPending()` 中维护状态：

```typescript
// 维护 StreamState
if (msg.type === 'stream_event') {
  const event = (msg as any).event;
  if (event?.type === 'content_block_delta' && event.delta?.text) {
    this.streamState.hasStreamedText = true;
  }
}
if (msg.type === 'result') {
  this.streamState.hasReceivedResult = true;
}
```

2c. 修正 `cliMessageToSseString()` 的 assistant 分支：

```typescript
case 'assistant': {
  // 捕获 lastAssistantText 但不作为 text SSE 发出（stream_event 已发过）
  for (const block of assistant.message.content) {
    if (block.type === 'text' && block.text) {
      this.streamState.lastAssistantText += block.text;
    } else if (block.type === 'tool_use') {
      // 补上 tool_use SSE 事件
      return sseEvent('tool_use', {
        id: block.id || '',
        name: block.name || '',
        input: block.input || {},
      });
    }
  }
  return null; // text 块不发出
}
```

2d. 在 `handleCrash()` 中利用 StreamState：

```typescript
private handleCrash(err: Error): void {
  // flush 剩余消息
  const remaining = this.ndjson.flush();
  for (const msg of remaining) { this.handleMessage(msg as CliMessage); }

  // 如果 result 已收到，这是传输层噪声
  if (this.streamState.hasReceivedResult) {
    console.log('[persistent] Suppressing crash — result already received');
    this.clearPendingResponse();
    this.state = 'dead';
    return;
  }

  // 如果 assistant 文本含 auth 错误，原样转发
  if (this.streamState.lastAssistantText && classifyAuthError(this.streamState.lastAssistantText)) {
    this.pendingResponse?.controller.enqueue(sseEvent('text', this.streamState.lastAssistantText));
    this.clearPendingResponse();
    this.state = 'dead';
    return;
  }

  // 真正的崩溃
  this.rejectPendingResponse(err);
  this.state = 'dead';
}
```

2e. 每次 `sendPrompt()` / `sendUserMessage()` 时重置 StreamState：

```typescript
sendPrompt(prompt: string): void {
  this.streamState = { hasReceivedResult: false, hasStreamedText: false, lastAssistantText: '' };
  // ... 原有逻辑
}
```

### 修复 3：result 消息字段名统一

**目标**：持久化路线的 result SSE 和 SDK 路线对齐。

**改动位置**：`cliMessageToSseString()` 的 result 分支

**需要统一的字段**：

| 字段 | SDK 路线 | 持久化路线（当前） | 应统一为 |
|------|---------|-------------------|---------|
| 费用 | `cost_usd` | `total_cost_usd` | 待确认消费端用哪个 |

### 修复 4：U+2028/U+2029 防护

**目标**：防止 AI 输出中的特殊 Unicode 字符破坏 NDJSON 解析。

**改动位置**：`PersistentProcess` 写入 stdin 的路径，以及 `sseEvent()` 的输出

**改动方案**：在 `process.ts` 中增加 `ndjsonSafeStringify` 工具函数，用于所有 stdin 写入和关键的 stdout 解析路径。

---

## 七、修复优先级

| 优先级 | 修复项 | 影响 | 改动量 |
|--------|--------|------|--------|
| **P0** | 修复 2：assistant 处理对齐 + StreamState | 文本重复输出 + 崩溃场景信息丢失 | ~60 行 |
| **P1** | 修复 1：统一用 sseEvent() | 格式一致性 + 特殊字符安全 | ~40 行 |
| **P2** | 修复 4：U+2028/U+2029 防护 | 防止 NDJSON 解析崩溃 | ~15 行 |
| **P3** | 修复 3：result 字段名统一 | 消费端兼容性 | ~5 行 |

---

## 八、相关文件索引

| 文件 | 角色 |
|------|------|
| `BuddyBridge/src/lib/bridge/host.ts` | `SSEEvent` 类型定义、`LLMProvider` 接口 |
| `BuddyBridge/src/lib/bridge/conversation-engine.ts` | SSE 消费端 `consumeStream()` |
| `BuddyBridge-skill/src/sse-utils.ts` | SSE 生产端 `sseEvent()` |
| `BuddyBridge-skill/src/llm-provider.ts` | Claude SDK Provider + `handleMessage()` |
| `BuddyBridge-skill/src/codebuddysdk-provider.ts` | CodeBuddy SDK Provider + `handleMessage()` |
| `BuddyBridge-skill/src/codebuddy-provider.ts` | CodeBuddy 裸 CLI Provider |
| `BuddyBridge-skill/src/lib/persistent-claude/process.ts` | `PersistentProcess` + `cliMessageToSseString()` |
| `BuddyBridge-skill/src/lib/persistent-claude/ndjson.ts` | `NdjsonParser` |
| `BuddyBridge-skill/src/lib/persistent-claude/types.ts` | `CliMessage` 类型、`FallbackTracker` |
| `BuddyBridge-skill/src/lib/persistent-claude/provider.ts` | `PersistentClaudeProvider` |
| `BuddyBridge-skill/src/lib/persistent-codebuddy/provider.ts` | `PersistentCodeBuddyProvider` |
