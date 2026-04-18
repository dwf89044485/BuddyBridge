# BuddyBridge Provider 体系：持久化 vs 普通 Provider 深度分析

## 一、Provider 全景分类

| 类型 | Provider | 通信方式 | Fallback |
|------|----------|----------|----------|
| 持久化 | `PersistentClaudeProvider` | 长驻子进程 + stdin/stdout 双向 NDJSON | -> `SDKLLMProvider` |
| 持久化 | `PersistentCodeBuddyProvider` | 长驻子进程 + stdin/stdout 双向 NDJSON | -> `CodeBuddySDKProvider` |
| 普通 | `SDKLLMProvider` | 每次消息新起进程，通过 SDK `query()` | 无 |
| 普通 | `CodeBuddySDKProvider` | 每次消息新起进程，通过 SDK `query()` | 无 |
| 普通 | `CodeBuddyProvider` | 每次消息新起进程，裸 CLI spawn | 无 |

### Provider 解析链（按 runtime）

| Runtime | 链（按优先级） |
|---------|---------------|
| `codebuddy` | persistent-codebuddy -> codebuddysdk -> persistent-claude -> claude -> codex |
| `claude` | persistent-claude -> claude -> codex |
| `codex` | codex |

---

## 二、核心差异：进程模型

### 普通 Provider — "一次性进程"

每次 `streamChat()` 调用：
1. SDK `query()` 内部 spawn 一个新 CLI 子进程
2. CLI 处理完一条消息后退出
3. 会话连续性靠 `--resume <sessionId>` 从磁盘恢复

```
消息1 -> spawn 进程 -> 处理 -> 进程退出 -> spawn 进程 -> 处理 -> 进程退出
         ^ 启动开销           ^ 启动开销
```

### 持久化 Provider — "长驻进程 + 双向管道"

1. 首次 `streamChat()` 时 spawn CLI 并保持存活
2. 后续消息通过 stdin 写入 NDJSON，从 stdout 读取响应
3. CLI 进程在内存中保留完整会话上下文，不需要 `--resume`

```
spawn 进程 -> stdin 写消息1 -> stdout 读响应 -> stdin 写消息2 -> stdout 读响应 -> ...
              ^ 无启动开销                     ^ 无启动开销
```

---

## 三、七维对比

### 1. 进程生命周期管理

| 维度 | 普通 | 持久化 |
|------|------|--------|
| 进程存活时间 | 单条消息（秒级） | 跨消息持续（分钟到小时） |
| 需要管理进程池 | 否 | 是（`ProcessPool` 单例） |
| GC / 资源回收 | 不需要（进程自动退出） | 需要（60s 轮询 GC，30min idle 超时回收） |
| 进程上限 | 无（同时只存在1个） | 默认 20 个（LRU 淘汰） |
| 状态机 | 无 | `dead -> starting -> ready <-> busy -> shutting_down -> dead` |

### 2. 通信协议

| 维度 | 普通 | 持久化 |
|------|------|--------|
| 调用方式 | SDK `query()` 封装 | 直接 `spawn()` + 原始 stdin/stdout |
| 消息格式 | SDK 内部处理 | 手写 NDJSON 解析（`NdjsonParser`） |
| 输入格式 | SDK 自动构建 | 手动构建 `{type:'user', message:{...}}` 写入 stdin |
| 输出格式 | SDK 的 `SDKMessage` 类型 | 手动解析 stdout NDJSON -> `CliMessage` -> SSE 转换 |
| 控制协议 | SDK 封装 | 手写 `control_request`/`control_response`（中断、切换模型、权限回调） |

### 3. 会话连续性

| 维度 | 普通 | 持久化 |
|------|------|--------|
| 机制 | `--resume <sessionId>` 从磁盘恢复 | 进程内存中天然保持 |
| 上下文恢复延迟 | 每次都要重新加载 | 零延迟 |
| 上下文完整性 | 依赖 CLI 的 resume 实现 | 内存中的状态是最新的 |

### 4. 权限处理

| 维度 | 普通 | 持久化 |
|------|------|--------|
| 权限回调 | SDK `canUseTool` 回调 | CLI 主动发 `control_request {subtype:'can_use_tool'}`，Provider 返回 `control_response` |
| 权限提示工具 | SDK 自动处理 | Claude: `--permission-prompt-tool stdio`；CodeBuddy: 关闭此选项 |

### 5. 模型切换

| 维度 | 普通 | 持久化 |
|------|------|--------|
| 方式 | 每次新进程传 `--model` | 运行时发 `control_request {subtype:'set_model'}` |
| Claude | 不适用 | `proc.setModel()` 原地切换，进程不重启 |
| CodeBuddy | 不适用 | ~~杀掉重建~~ 已改为 `proc.setModel()` 热切换 |

### 6. 容错与降级

| 维度 | 普通 | 持久化 |
|------|------|--------|
| 失败恢复 | 无降级（本身已是底层） | 自动降级到对应普通 Provider |
| 失败追踪 | 无 | `FallbackTracker`：按错误类型分类处理 |
| 全局禁用 | 不适用 | `CTI_PERSISTENT_CLAUDE=0` / `CTI_PERSISTENT_CODEBUDDY=0` |
| 进程崩溃 | 整个 streamChat 失败 | `handleCrash()` -> 降级到普通 Provider |
| keep_alive | 不需要 | 30s 间隔发送 `keep_alive` SSE 事件 |

### 7. SSE 事件转换

| 维度 | 普通 | 持久化 |
|------|------|--------|
| 转换方式 | SDK `SDKMessage` -> `handleMessage()` -> `sseEvent()` | CLI 原始 NDJSON -> `cliMessageToSseString()` 手动转换 |
| 格式差异 | 统一通过 `sseEvent()` | 部分手动拼 JSON，存在不一致风险 |
| status 事件 | 无额外标记 | 额外带 `_internal: true, persistent_process: true` |

---

## 四、SSE 转换体系深度分析

### 4.1 为什么有两套 SSE 转换器？

数据流路径：

```
CLI 子进程 -> stdout NDJSON -> [转换器] -> SSE 事件字符串 -> 对话引擎
```

- **SDK 路线**：SDK `query()` 把 NDJSON 解析成类型化的 `SDKMessage` 对象，`handleMessage()` 负责从对象提取字段，调 `sseEvent()` 产出 SSE
- **持久化路线**：绕过 SDK，`NdjsonParser` 把 NDJSON 解析成泛型 `CliMessage`，`cliMessageToSseString()` 手动拼 JSON 产出 SSE

两套转换器存在是因为输入格式不同，不是主动选择维护两套。

### 4.2 BuddyBridge 的 SSE 格式：双层 JSON

BuddyBridge 使用**双层 JSON 编码**：

```
data: {"type":"text","data":"你好"}\n
data: {"type":"tool_use","data":"{\"id\":\"abc\",\"name\":\"Read\"}"}\n
```

外层 `{type, data}` 中，`data` 字段始终是 string：
- text 事件：data 就是纯文本
- 结构化事件：data 是 JSON.stringify 后的字符串（需要二次 parse）

消费端（`conversation-engine.ts`）的解析逻辑：
1. `JSON.parse(line.slice(6))` -> `{ type, data: string }`
2. text/error 事件：`event.data` 直接当字符串用
3. tool_use/result/permission_request 等事件：`JSON.parse(event.data)` 二次解析

### 4.3 双层 JSON vs 业界实践

| 实现方 | data 字段格式 | 示例 |
|--------|-------------|------|
| OpenAI API | 单层 JSON 对象 | `data: {"choices":[{"delta":{"content":"你好"}}]}` |
| Anthropic Claude API | 单层 JSON 对象 + `event:` 字段 | `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"你好"}}` |
| Vercel AI SDK | 单层 JSON 对象 | `data: {"type":"text-delta","delta":"你好"}` |
| **BuddyBridge** | **双层 JSON** | `data: {"type":"text","data":"你好"}` |

**业界标准是单层 JSON**。Anthropic 的做法最规范：用 SSE 规范的 `event:` 字段做类型路由，`data:` 字段就是纯 JSON 对象，一次 parse 即可。

双层 JSON 的"价值"是让 `SSEEvent.data` 类型签名统一为 `string`，简化了 TypeScript 类型。代价是：
1. 与所有主流 SSE 实现不兼容
2. 手写双层编码是 bug 温床（持久化路线的手动拼 JSON 已有格式不一致问题）
3. 消费端需要根据事件类型决定是否二次 parse

**当前决策**：保持双层格式不变（消费端改动成本高），但所有产出端统一通过 `sseEvent()` 生成，保证格式一致性。

### 4.4 两套转换器的具体差异

| 能力 | SDK `handleMessage()` | 持久化 `cliMessageToSseString()` |
|------|----------------------|----------------------------------|
| `lastAssistantText` 捕获 | 有（用于 auth 错误分类） | 无 |
| 传输噪声抑制 | 有（`hasReceivedResult` 判断） | 无 |
| 部分输出+崩溃检测 | 有（`hasStreamedText` 判断） | 无 |
| stderr 诊断 | 有（4KB ring buffer + 分类） | 有 buffer 但未用于消息转换 |
| assistant 中 tool_use 块 | 发 `tool_use` SSE 事件 | 完全忽略 |
| assistant 中 text 块 | 只捕获不发出（stream_event 已发过） | 直接作为 `text` SSE 发出（导致重复） |

### 4.5 官方 SDK 的处理方式

两个 SDK（Anthropic `@anthropic-ai/claude-agent-sdk` 和 Tencent `@tencent-ai/agent-sdk`）做法一致：
- `stream_event`（增量 delta）和 `assistant`（完整消息）都原样抛给消费者
- 通过 `includePartialMessages` 控制取舍：`false` 只抛 `assistant`，`true` 两个都抛
- **不做去重**，去重是消费者（BuddyBridge）的责任
- **没有 StreamState**，SDK 不做内容级别的状态追踪

### 4.6 NDJSON 安全性：U+2028/U+2029

Anthropic 官方 CLI 有 `ndjsonSafeStringify` 函数，处理 U+2028（Line Separator）和 U+2029（Paragraph Separator）。这两个字符在 JSON 中合法，但作为行终止符会破坏 NDJSON 按行切割。BuddyBridge 的 `NdjsonParser` 目前没有此防护。

---

## 五、Fallback Tracker 降级机制

### 5.1 原始设计

- 同一 session 连续 3 次崩溃 -> 禁用持久化 5 分钟
- 5 分钟到期后自动恢复
- 所有错误类型一视同仁（OOM、auth 错误、quota 错误）

### 5.2 改进后设计（已实施）

- **错误分类**：`recordFailure(sessionId, err)` 接受 Error 参数
  - Auth/quota 错误 -> 标记 `unrecoverable`，立即禁用，不等 3 次重试
  - 普通错误 -> 保持原逻辑，3 次后禁用 5 分钟
- **健康检查恢复**：`shouldUsePersistent()` 在遇到 `unrecoverable` 标记时，调用 `cliHealthCheck()` / `codebuddyHealthCheck()` 探活
  - 探活通过（CLI 能启动）-> 立即恢复持久化模式
  - 探活失败 -> 继续禁用
- 可恢复错误仍按超时自动恢复

### 5.3 相关代码位置

- `FallbackEntry` 类型定义：`persistent-claude/types.ts`
- Claude 持久化 fallback 逻辑：`persistent-claude/provider.ts`
- CodeBuddy 持久化 fallback 逻辑：`persistent-codebuddy/provider.ts`
- 错误分类函数：`llm-provider.ts: classifyAuthError()`、`codebuddysdk-provider.ts: classifyCodeBuddyAuthError()`

---

## 六、CodeBuddy 模型切换改进

### 6.1 原始问题

`PersistentCodeBuddyProvider` 在模型变更时杀掉重建进程，而 Claude 持久化用 `proc.setModel()` 热切换。

### 6.2 事实确认

- `@tencent-ai/agent-sdk` 的 `query()` 对象支持 `setModel()` 方法
- `PersistentProcess` 类已有 `setModel()` 实现（发送 `control_request {subtype: 'set_model'}`）
- CodeBuddy CLI 支持 `set_model` 控制指令
- 但 `PersistentCodeBuddyProvider` 没有使用它，直接选了杀重建

### 6.3 已实施改进

从杀重建改为热切换，和 Claude 持久化对齐：

```typescript
// 之前：杀掉重建
if (targetModel && proc.model && proc.model !== targetModel) {
  await pool.disconnect(sessionId);
  proc = await pool.connect(sessionId, { model: params.model, ... });
}

// 现在：原地切换
if (targetModel && proc.model && proc.model !== targetModel) {
  await proc.setModel(targetModel).catch((err) => {
    console.warn(`[persistent-codebuddy] setModel failed: ${err.message}`);
  });
}
```

---

## 七、待实施的 SSE 转换统一方案

### 7.1 改进 1：统一用 `sseEvent()` 生成所有 SSE 输出

把 `cliMessageToSseString()` 里所有手动拼 JSON 的地方替换成 `sseEvent()` 调用。

### 7.2 改进 2：assistant 消息处理对齐 SDK 语义

根据官方 SDK 的设计意图：
- `stream_event` 的 text_delta 负责增量输出
- `assistant` 消息是"完整确认"，不应再次作为 `text` SSE 发出（否则文本重复）
- `assistant` 中的 `tool_use` 块应发出 SSE 事件

给 `PersistentProcess` 增加 `StreamState`，在 `forwardToPending()` 中维护状态，在 `handleCrash()` 中使用。

### 7.3 改进 3：U+2028/U+2029 防护

在 `NdjsonParser` 或 `PersistentProcess` 的写入路径中，对 `JSON.stringify` 输出做 U+2028/U+2029 转义：

```typescript
function ndjsonSafeStringify(obj: unknown): string {
  return JSON.stringify(obj).replace(/\u2028|\u2029/g, (ch) =>
    ch === '\u2028' ? '\\u2028' : '\\u2029'
  );
}
```

---

## 八、架构总览图

```
BuddyBridge (Core Library)
  |
  +-- host.ts: LLMProvider interface (streamChat)
  +-- host.ts: SSEEvent { type: SSEEventType; data: string }
  +-- context.ts: BridgeContext { llm: LLMProvider, runtime, ... }
  |
  |  (injected at startup by skill layer)

BuddyBridge-skill (Skill Layer)
  |
  +-- main.ts: resolveProvider()
  |     |
  |     +-- chainForRuntime('codebuddy'): persistent-codebuddy -> codebuddysdk -> persistent-claude -> claude -> codex
  |     +-- chainForRuntime('claude'):     persistent-claude -> claude -> codex
  |     +-- chainForRuntime('codex'):      codex
  |
  +-- Non-Persistent Providers:
  |     +-- llm-provider.ts:        SDKLLMProvider (Claude SDK query())
  |     +-- codebuddy-provider.ts:  CodeBuddyProvider (raw CLI subprocess)
  |     +-- codebuddysdk-provider.ts: CodeBuddySDKProvider (CodeBuddy SDK query())
  |
  +-- Persistent Providers:
  |     +-- lib/persistent-claude/
  |     |     +-- provider.ts:    PersistentClaudeProvider (falls back to SDKLLMProvider)
  |     |     +-- process-pool.ts: ProcessPool (session-keyed process management, GC, eviction)
  |     |     +-- process.ts:     PersistentProcess (state machine, stdin/stdout NDJSON)
  |     |     +-- types.ts:       ProcessState, PoolConfig, FallbackTracker, CLI message types
  |     |     +-- ndjson.ts:      NdjsonParser
  |     |
  |     +-- lib/persistent-codebuddy/
  |           +-- provider.ts:    PersistentCodeBuddyProvider (falls back to CodeBuddySDKProvider)
  |           +-- index.ts:       Exports
  |
  +-- sse-utils.ts: sseEvent() - SSE 产出统一入口
  +-- config.ts: Config { runtime, autoApprove, ... }, normalizeRuntime()
```
