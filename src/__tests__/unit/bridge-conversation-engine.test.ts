import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { initBridgeContext } from '../../lib/bridge/context';
import { processMessage } from '../../lib/bridge/conversation-engine';
import type {
  BridgeApiProvider,
  BridgeMessage,
  BridgeSession,
  BridgeStore,
  LLMProvider,
  LifecycleHooks,
  PermissionGateway,
  StreamChatParams,
} from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

class InMemoryConversationStore implements BridgeStore {
  private readonly settings = new Map<string, string>();
  private readonly sessions = new Map<string, BridgeSession>();
  private readonly messages = new Map<string, BridgeMessage[]>();
  private readonly scopedPrompts = new Map<string, {
    id: string;
    scopeKey: string;
    channelType: string;
    scopeType: string;
    prompt: string;
    createdAt: string;
    updatedAt: string;
  }>();

  constructor() {
    this.settings.set('default_model', 'test-model');
  }

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  getChannelBinding(): ChannelBinding | null {
    return null;
  }

  upsertChannelBinding(): ChannelBinding {
    throw new Error('Not implemented in this test store');
  }

  updateChannelBinding(): void {}

  listChannelBindings(): ChannelBinding[] {
    return [];
  }

  getScopedSystemPrompt(scopeKey: string) {
    return this.scopedPrompts.get(scopeKey) ?? null;
  }

  upsertScopedSystemPrompt(data: { scopeKey: string; channelType: string; scopeType: string; prompt: string }) {
    const now = new Date().toISOString();
    const existing = this.scopedPrompts.get(data.scopeKey);
    const next = existing
      ? { ...existing, ...data, updatedAt: now }
      : {
        id: `scope-${this.scopedPrompts.size + 1}`,
        ...data,
        createdAt: now,
        updatedAt: now,
      };
    this.scopedPrompts.set(data.scopeKey, next);
    return next;
  }

  deleteScopedSystemPrompt(scopeKey: string): boolean {
    return this.scopedPrompts.delete(scopeKey);
  }

  listScopedSystemPrompts(channelType?: string) {
    const all = Array.from(this.scopedPrompts.values());
    if (!channelType) return all;
    return all.filter((item) => item.channelType === channelType || item.channelType === 'global');
  }

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(_name: string, model: string, systemPrompt?: string, cwd?: string): BridgeSession {
    const session: BridgeSession = {
      id: `session-${this.sessions.size + 1}`,
      working_directory: cwd || '/tmp',
      model,
      system_prompt: systemPrompt,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.provider_id = providerId;
    }
  }

  addMessage(sessionId: string, role: string, content: string): void {
    const list = this.messages.get(sessionId) || [];
    list.push({ role, content });
    this.messages.set(sessionId, list);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const list = this.messages.get(sessionId) || [];
    if (opts?.limit) {
      return { messages: list.slice(-opts.limit) };
    }
    return { messages: [...list] };
  }

  acquireSessionLock(): boolean { return true; }
  renewSessionLock(): void {}
  releaseSessionLock(): void {}
  setSessionRuntimeStatus(): void {}
  updateSdkSessionId(): void {}
  updateSessionModel(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.model = model;
  }
  syncSdkTasks(): void {}
  getProvider(): BridgeApiProvider | undefined { return undefined; }
  getDefaultProviderId(): string | null { return null; }
  insertAuditLog(): void {}
  checkDedup(): boolean { return false; }
  insertDedup(): void {}
  cleanupExpiredDedup(): void {}
  insertOutboundRef(): void {}
  insertPermissionLink(): void {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved(): boolean { return false; }
  listPendingPermissionLinksByChat() { return []; }
  getChannelOffset(): string { return '0'; }
  setChannelOffset(): void {}
}

describe('conversation-engine scoped prompts', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('builds layered system prompt from inherited scopes', async () => {
    const store = new InMemoryConversationStore();
    const session = store.createSession('test', 'test-model', '你是默认系统提示', '/tmp/test-cwd');

    const binding: ChannelBinding = {
      id: 'binding-1',
      channelType: 'discord',
      chatId: 'thread-1',
      scopeKey: 'discord:thread:thread-1',
      scopeChain: [
        { kind: 'guild', id: 'guild-1' },
        { kind: 'channel', id: 'channel-1' },
        { kind: 'thread', id: 'thread-1' },
      ],
      codepilotSessionId: session.id,
      sdkSessionId: '',
      workingDirectory: '/tmp/test-cwd',
      model: 'test-model',
      mode: 'code',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.upsertScopedSystemPrompt({
      scopeKey: 'global',
      channelType: 'global',
      scopeType: 'global',
      prompt: '全局要求A',
    });
    store.upsertScopedSystemPrompt({
      scopeKey: 'platform:discord',
      channelType: 'discord',
      scopeType: 'platform',
      prompt: '平台要求B',
    });
    store.upsertScopedSystemPrompt({
      scopeKey: 'discord:channel:channel-1',
      channelType: 'discord',
      scopeType: 'channel',
      prompt: '频道要求C',
    });
    store.upsertScopedSystemPrompt({
      scopeKey: 'discord:thread:thread-1',
      channelType: 'discord',
      scopeType: 'thread',
      prompt: '子区要求D',
    });

    let capturedParams: StreamChatParams | undefined;
    const llm: LLMProvider = {
      streamChat(params: StreamChatParams): ReadableStream<string> {
        capturedParams = params;
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue('data: {"type":"text","data":"ok"}\n');
            controller.enqueue('data: {"type":"result","data":"{\\"usage\\":{\\"input_tokens\\":1,\\"output_tokens\\":1},\\"is_error\\":false}"}\n');
            controller.close();
          },
        });
      },
    };

    const permissions: PermissionGateway = {
      resolvePendingPermission(): boolean {
        return false;
      },
    };
    const lifecycle: LifecycleHooks = {};

    initBridgeContext({ store, llm, permissions, lifecycle });

    const result = await processMessage(binding, '嗨');

    assert.equal(result.responseText, 'ok');
    assert.ok(capturedParams?.systemPrompt);
    assert.match(capturedParams!.systemPrompt!, /你是默认系统提示/);
    assert.match(capturedParams!.systemPrompt!, /以下是当前消息命中的分层规则/);
    assert.match(capturedParams!.systemPrompt!, /【全局规则】\n全局要求A/);
    assert.match(capturedParams!.systemPrompt!, /【平台规则（discord）】\n平台要求B/);
    assert.match(capturedParams!.systemPrompt!, /【频道规则（channel-1）】\n频道要求C/);
    assert.match(capturedParams!.systemPrompt!, /【子区规则（thread-1）】\n子区要求D/);

    const globalIndex = capturedParams!.systemPrompt!.indexOf('【全局规则】');
    const platformIndex = capturedParams!.systemPrompt!.indexOf('【平台规则（discord）】');
    const channelIndex = capturedParams!.systemPrompt!.indexOf('【频道规则（channel-1）】');
    const threadIndex = capturedParams!.systemPrompt!.indexOf('【子区规则（thread-1）】');

    assert.ok(globalIndex >= 0 && platformIndex > globalIndex);
    assert.ok(channelIndex > platformIndex);
    assert.ok(threadIndex > channelIndex);
    assert.match(capturedParams!.systemPrompt!, /如果不同层级存在冲突，以更具体、位置更靠后的规则为准/);
  });

  it('passes persisted file paths only for non-image attachments', async () => {
    const store = new InMemoryConversationStore();
    const tempRoot = await import('node:fs/promises').then(fs => fs.mkdtemp('/tmp/bridge-attachments-'));
    const session = store.createSession('test', 'test-model', undefined, tempRoot);

    const binding: ChannelBinding = {
      id: 'binding-attachments',
      channelType: 'discord',
      chatId: 'thread-attachments',
      scopeKey: 'discord:thread:thread-attachments',
      scopeChain: [],
      codepilotSessionId: session.id,
      sdkSessionId: '',
      workingDirectory: tempRoot,
      model: 'test-model',
      mode: 'code',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let capturedParams: StreamChatParams | undefined;
    const llm: LLMProvider = {
      streamChat(params: StreamChatParams): ReadableStream<string> {
        capturedParams = params;
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue('data: {"type":"text","data":"ok"}\n');
            controller.enqueue('data: {"type":"result","data":"{\\"usage\\":{\\"input_tokens\\":1,\\"output_tokens\\":1},\\"is_error\\":false}"}\n');
            controller.close();
          },
        });
      },
    };

    const permissions: PermissionGateway = {
      resolvePendingPermission(): boolean {
        return false;
      },
    };
    const lifecycle: LifecycleHooks = {};

    initBridgeContext({ store, llm, permissions, lifecycle });

    await processMessage(binding, '请读取这个文件', undefined, undefined, [{
      id: 'file-1',
      name: '需求说明.txt',
      type: 'text/plain',
      size: 5,
      data: Buffer.from('hello').toString('base64'),
    }, {
      id: 'file-2',
      name: '示意图.png',
      type: 'image/png',
      size: 4,
      data: Buffer.from('png!').toString('base64'),
    }]);

    assert.ok(capturedParams?.files);
    assert.equal(capturedParams!.files!.length, 2);
    assert.equal(capturedParams!.files![0].name, '需求说明.txt');
    assert.ok(capturedParams!.files![0].filePath, 'non-image filePath should be attached after persistence');
    assert.match(capturedParams!.files![0].filePath!, /\.uploads\//);
    assert.match(capturedParams!.files![0].filePath!, new RegExp(`\.uploads/${session.id}/`));
    assert.match(capturedParams!.prompt, /用户上传了以下附件/);
    assert.match(capturedParams!.prompt, /请先使用读文件工具按路径读取这些文件/);
    assert.match(capturedParams!.prompt, /需求说明/);
    assert.equal(capturedParams!.files![1].name, '示意图.png');
    assert.equal(capturedParams!.files![1].filePath, undefined);
  });
});