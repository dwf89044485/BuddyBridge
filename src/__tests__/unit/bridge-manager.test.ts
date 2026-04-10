/**
 * Unit tests for bridge-manager.
 *
 * Tests cover:
 * - Session lock concurrency: same-session serialization
 * - Session lock concurrency: different-session parallelism
 * - Bridge start/stop lifecycle
 * - Auto-start idempotency
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initBridgeContext } from '../../lib/bridge/context';
import type { AuditLogInput, BridgeStore, LifecycleHooks, OutboundRefInput } from '../../lib/bridge/host';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { ChannelBinding, OutboundMessage, SendResult } from '../../lib/bridge/types';

// ── Test the session lock mechanism directly ────────────────
// We test the processWithSessionLock pattern by extracting its logic.

function createSessionLocks() {
  const locks = new Map<string, Promise<void>>();

  function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = locks.get(sessionId) || Promise.resolve();
    const current = prev.then(fn, fn);
    locks.set(sessionId, current);
    // Suppress unhandled rejection on the cleanup chain — callers handle the error on `current` directly
    current.finally(() => {
      if (locks.get(sessionId) === current) {
        locks.delete(sessionId);
      }
    }).catch(() => {});
    return current;
  }

  return { locks, processWithSessionLock };
}

describe('bridge-manager session locks', () => {
  it('serializes same-session operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, [1, 2], 'Same-session operations should be serialized');
  });

  it('allows different-session operations to run concurrently', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const started: string[] = [];
    const completed: string[] = [];

    const p1 = processWithSessionLock('session-A', async () => {
      started.push('A');
      await new Promise(r => setTimeout(r, 50));
      completed.push('A');
    });

    const p2 = processWithSessionLock('session-B', async () => {
      started.push('B');
      await new Promise(r => setTimeout(r, 10));
      completed.push('B');
    });

    await Promise.all([p1, p2]);
    // Both should start before either completes (concurrent)
    assert.equal(started.length, 2);
    // B should complete first since it has shorter delay
    assert.equal(completed[0], 'B');
    assert.equal(completed[1], 'A');
  });

  it('continues after errors in locked operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      order.push(1);
      throw new Error('test error');
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await p1.catch(() => {});
    await p2;
    assert.deepStrictEqual(order, [1, 2], 'Should continue after error');
  });

  it('cleans up completed locks', async () => {
    const { locks, processWithSessionLock } = createSessionLocks();

    await processWithSessionLock('session-1', async () => {});

    // Allow microtask to complete for finally() cleanup
    await new Promise(r => setTimeout(r, 0));
    assert.equal(locks.size, 0, 'Lock should be cleaned up after completion');
  });
});

// ── Lifecycle tests ─────────────────────────────────────────

describe('bridge-manager lifecycle', () => {
  beforeEach(() => {
    // Clear bridge manager state
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('getStatus returns not running when bridge has not started', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'false' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    // Import dynamically to get fresh module state
    const { getStatus } = await import('../../lib/bridge/bridge-manager');
    const status = getStatus();
    assert.equal(status.running, false);
    assert.equal(status.adapters.length, 0);
  });
});

describe('bridge-manager weekly upload reminder', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('reminds active bindings when .uploads contains files at Monday 10:00', async () => {
    const store = createModelSwitchStore({ remote_bridge_enabled: 'true' });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-reminder-'));
    const uploadDir = path.join(tempRoot, '.uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, '需求说明.txt'), 'hello');

    store.upsertChannelBinding({
      channelType: 'qq',
      chatId: 'chat-reminder',
      codepilotSessionId: 'session-reminder',
      sdkSessionId: '',
      workingDirectory: tempRoot,
      model: 'gpt-5.4',
      mode: 'code',
      scopeKey: 'qq:chat:chat-reminder',
      scopeChain: [{ kind: 'chat', id: 'chat-reminder' }],
    });
    store.sessions.set('session-reminder', { id: 'session-reminder', working_directory: tempRoot, model: 'gpt-5.4' });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);
    const { registerAdapter, _internals } = await import('../../lib/bridge/bridge-manager');
    registerAdapter(adapter);

    const now = new Date('2026-03-16T10:00:00');
    await _internals.runWeeklyUploadReminderCheck(now);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].address.chatId, 'chat-reminder');
    assert.equal(sentMessages[0].address.channelType, 'qq');
    assert.match(sentMessages[0].text || '', /当前共有 1 个文件/);
    assert.match(sentMessages[0].text || '', /\.uploads/);
    assert.equal(store.outboundRefs.length, 1);
    assert.equal(store.outboundRefs[0].chatId, 'chat-reminder');
    assert.equal(store.outboundRefs[0].codepilotSessionId, 'session-reminder');
    assert.equal(store.outboundRefs[0].purpose, 'response');
    assert.equal(store.auditLogs.length, 1);
    assert.equal(store.auditLogs[0].chatId, 'chat-reminder');
    assert.equal(store.auditLogs[0].direction, 'outbound');
    assert.equal(store.dedupKeys.size, 1);
    assert.ok(store.dedupKeys.has(_internals.getUploadReminderDedupKey('binding-qq-chat-reminder', now)));

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not remind outside Monday 10:00 or when directory is empty', async () => {
    const store = createModelSwitchStore({ remote_bridge_enabled: 'true' });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-reminder-empty-'));
    fs.mkdirSync(path.join(tempRoot, '.uploads'), { recursive: true });

    store.upsertChannelBinding({
      channelType: 'qq',
      chatId: 'chat-empty',
      codepilotSessionId: 'session-empty',
      sdkSessionId: '',
      workingDirectory: tempRoot,
      model: 'gpt-5.4',
      mode: 'code',
      scopeKey: 'qq:chat:chat-empty',
      scopeChain: [{ kind: 'chat', id: 'chat-empty' }],
    });
    store.sessions.set('session-empty', { id: 'session-empty', working_directory: tempRoot, model: 'gpt-5.4' });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);
    const { registerAdapter, _internals } = await import('../../lib/bridge/bridge-manager');
    registerAdapter(adapter);

    await _internals.runWeeklyUploadReminderCheck(new Date('2026-03-16T09:59:00'));
    await _internals.runWeeklyUploadReminderCheck(new Date('2026-03-16T10:00:00'));

    assert.equal(sentMessages.length, 0);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('deduplicates reminders for the same binding and time window', async () => {
    const store = createModelSwitchStore({ remote_bridge_enabled: 'true' });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-reminder-dedup-'));
    const uploadDir = path.join(tempRoot, '.uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, '需求说明.txt'), 'hello');

    store.upsertChannelBinding({
      channelType: 'qq',
      chatId: 'chat-dedup',
      codepilotSessionId: 'session-dedup',
      sdkSessionId: '',
      workingDirectory: tempRoot,
      model: 'gpt-5.4',
      mode: 'code',
      scopeKey: 'qq:chat:chat-dedup',
      scopeChain: [{ kind: 'chat', id: 'chat-dedup' }],
    });
    store.sessions.set('session-dedup', { id: 'session-dedup', working_directory: tempRoot, model: 'gpt-5.4' });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);
    const { registerAdapter, _internals } = await import('../../lib/bridge/bridge-manager');
    registerAdapter(adapter);

    const now = new Date('2026-03-16T10:00:00');
    await _internals.runWeeklyUploadReminderCheck(now);
    await _internals.runWeeklyUploadReminderCheck(now);

    assert.equal(sentMessages.length, 1);
    assert.equal(store.outboundRefs.length, 1);
    assert.equal(store.auditLogs.length, 1);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('retries future reminder checks when proactive delivery fails', async () => {
    const store = createModelSwitchStore({ remote_bridge_enabled: 'true' });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-reminder-fail-'));
    const uploadDir = path.join(tempRoot, '.uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, '待处理.csv'), 'id,name');

    store.upsertChannelBinding({
      channelType: 'qq',
      chatId: 'chat-fail',
      codepilotSessionId: 'session-fail',
      sdkSessionId: '',
      workingDirectory: tempRoot,
      model: 'gpt-5.4',
      mode: 'code',
      scopeKey: 'qq:chat:chat-fail',
      scopeChain: [{ kind: 'chat', id: 'chat-fail' }],
    });
    store.sessions.set('session-fail', { id: 'session-fail', working_directory: tempRoot, model: 'gpt-5.4' });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sentMessages: OutboundMessage[] = [];
    const sendResults: SendResult[] = [
      { ok: false, error: 'permanent send failure', httpStatus: 400 } as SendResult,
      { ok: false, error: 'permanent send failure', httpStatus: 400 } as SendResult,
    ];
    const adapter = createCommandTestAdapter(sentMessages, () => sendResults.shift() || ({ ok: false, error: 'permanent send failure', httpStatus: 400 } as SendResult));
    const { registerAdapter, _internals } = await import('../../lib/bridge/bridge-manager');
    registerAdapter(adapter);

    const now = new Date('2026-03-16T10:00:00');
    await _internals.runWeeklyUploadReminderCheck(now);
    await _internals.runWeeklyUploadReminderCheck(now);

    assert.equal(sentMessages.length, 2);
    assert.equal(sentMessages[0].address.chatId, 'chat-fail');
    assert.equal(sentMessages[1].address.chatId, 'chat-fail');
    assert.equal(store.dedupKeys.size, 0);
    assert.equal(store.outboundRefs.length, 0);
    assert.equal(store.auditLogs.length, 0);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

describe('bridge-manager attachment prompt selection', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('does not use image fallback prompt for file-only attachments', async () => {
    const store = createModelSwitchStore({
      bridge_default_model: 'gpt-5.4',
    });

    let capturedPrompt = '';
    initBridgeContext({
      store,
      llm: {
        streamChat: (params) => {
          capturedPrompt = params.prompt;
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue('data: {"type":"text","data":"ok"}\n');
              controller.enqueue('data: {"type":"result","usage":{"input_tokens":1,"output_tokens":1},"is_error":false}\n');
              controller.close();
            },
          });
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-file-only',
      address: { channelType: 'qq', chatId: 'chat-file-only', userId: 'user-1' },
      text: '',
      timestamp: Date.now(),
      attachments: [{
        id: 'file-1',
        name: '说明.txt',
        type: 'text/plain',
        size: 5,
        data: Buffer.from('hello').toString('base64'),
      }],
    });

    assert.doesNotMatch(capturedPrompt, /Describe this image\./);
    assert.match(capturedPrompt, /用户上传了以下附件/);
    assert.match(capturedPrompt, /说明/);
  });
});

describe('bridge-manager prompt commands', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('sets and reads scoped prompt via /prompt set and /prompt get', async () => {
    const store = createModelSwitchStore({
      bridge_default_model: 'gpt-5.4',
    });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-prompt-set',
      address: {
        channelType: 'qq',
        chatId: 'chat-prompt-set',
        userId: 'user-1',
        scopeChain: [
          { kind: 'guild', id: 'guild-1' },
          { kind: 'thread', id: 'thread-1' },
        ],
      },
      text: '/prompt set Thread prompt rules',
      timestamp: Date.now(),
    });

    assert.equal(store.getScopedSystemPrompt('qq:thread:thread-1')?.prompt, 'Thread prompt rules');
    assert.match(sentMessages[0].text || '', /已保存当前作用域 Prompt/);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-prompt-overview-after-set',
      address: {
        channelType: 'qq',
        chatId: 'chat-prompt-set',
        userId: 'user-1',
        scopeChain: [
          { kind: 'guild', id: 'guild-1' },
          { kind: 'thread', id: 'thread-1' },
        ],
      },
      text: '/prompt',
      timestamp: Date.now(),
    });

    assert.match(sentMessages[1].text || '', /当前作用域/);
    assert.match(sentMessages[1].text || '', /Thread prompt rules/);
  });

  it('shows prompt overview when /prompt has no subcommand', async () => {
    const store = createModelSwitchStore({
      bridge_default_model: 'gpt-5.4',
    });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-prompt-overview',
      address: {
        channelType: 'qq',
        chatId: 'chat-prompt-overview',
        userId: 'user-1',
        scopeChain: [
          { kind: 'guild', id: 'guild-1' },
          { kind: 'thread', id: 'thread-1' },
        ],
      },
      text: '/prompt',
      timestamp: Date.now(),
    });

    const output = sentMessages[0].text || '';
    assert.ok(output.includes('作用域 Prompt 管理'));
    assert.ok(output.includes('切换方式'));
    assert.ok(output.includes('1. <code>global</code>'));
    assert.ok(output.includes('2. <code>platform:qq</code>'));
    assert.ok(output.includes('3. <code>qq:guild:guild-1</code>'));
    assert.ok(output.includes('4. <code>qq:thread:thread-1</code>'));
  });

  it('returns usage hint when /prompt get is used', async () => {
    const store = createModelSwitchStore({
      bridge_default_model: 'gpt-5.4',
    });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-prompt-get-removed',
      address: {
        channelType: 'qq',
        chatId: 'chat-prompt-get',
        userId: 'user-1',
      },
      text: '/prompt get',
      timestamp: Date.now(),
    });

    const output = sentMessages[0].text || '';
    assert.match(output, /未识别的 \/prompt 子命令/);
    assert.match(output, /当前仅支持 <code>\/prompt<\/code>、<code>\/prompt set<\/code>、<code>\/prompt clear<\/code>/);
  });
});

describe('bridge-manager model switch commands', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('shows current model and shortcut hints for /model', async () => {
    const store = createModelSwitchStore({
      bridge_default_model: 'kimi-k2.5-ioa',
    });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-model-help',
      address: { channelType: 'qq', chatId: 'chat-model-help', userId: 'user-1' },
      text: '/model',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].text || '', /模型切换/);
    assert.match(sentMessages[0].text || '', /当前模型：<code>kimi-k2.5-ioa<\/code>/);
    assert.match(sentMessages[0].text || '', /<code>claude-sonnet-4\.6<\/code>（<code>\/sonnet<\/code>）/);
    assert.match(sentMessages[0].text || '', /<code>gpt-5\.4<\/code>（<code>\/gpt<\/code>）/);
    assert.match(sentMessages[0].text || '', /选型建议/);
  });

  it('switches binding and session model via /model <name> and clears sdkSessionId', async () => {
    const store = createModelSwitchStore({
      bridge_default_model: 'claude-sonnet-4-20250514',
    });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-model-set',
      address: { channelType: 'qq', chatId: 'chat-model-set', userId: 'user-1' },
      text: '/model gpt-5',
      timestamp: Date.now(),
    });

    const binding = store.getChannelBinding('qq', 'chat-model-set');
    assert.ok(binding);
    assert.equal(binding?.model, 'gpt-5');
    assert.equal(binding?.sdkSessionId, '');
    assert.equal(store.sessionModelUpdates.at(-1)?.model, 'gpt-5');
    assert.equal(store.getSession(binding?.codepilotSessionId!)?.model, 'gpt-5');
    assert.match(sentMessages[0].text || '', /已切换到模型 <code>gpt-5<\/code>/);
  });

  it('switches model via /gpt shortcut', async () => {
    const store = createModelSwitchStore({
      bridge_default_model: 'claude-sonnet-4-20250514',
    });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-gpt-shortcut',
      address: { channelType: 'qq', chatId: 'chat-gpt-shortcut', userId: 'user-1' },
      text: '/gpt',
      timestamp: Date.now(),
    });

    const binding = store.getChannelBinding('qq', 'chat-gpt-shortcut');
    assert.equal(binding?.model, 'gpt-5.4');
    assert.equal(store.getSession(binding?.codepilotSessionId!)?.model, 'gpt-5.4');
    assert.match(sentMessages[0].text || '', /已通过 <code>\/gpt<\/code> 切换到 <code>gpt-5\.4<\/code>/);
  });

  it('switches model via /gpt code shortcut', async () => {
    const store = createModelSwitchStore({
      bridge_default_model: 'claude-sonnet-4-20250514',
    });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-gpt-code-shortcut',
      address: { channelType: 'qq', chatId: 'chat-gpt-code-shortcut', userId: 'user-1' },
      text: '/gpt code',
      timestamp: Date.now(),
    });

    const binding = store.getChannelBinding('qq', 'chat-gpt-code-shortcut');
    assert.equal(binding?.model, 'gpt-5.3-codex');
    assert.equal(store.getSession(binding?.codepilotSessionId!)?.model, 'gpt-5.3-codex');
    assert.match(sentMessages[0].text || '', /已通过 <code>\/gpt code<\/code> 切换到 <code>gpt-5\.3-codex<\/code>/);
  });
});

function createCommandTestAdapter(sentMessages: OutboundMessage[], sendImpl?: (msg: OutboundMessage) => Promise<SendResult> | SendResult): BaseChannelAdapter {
  return {
    channelType: 'qq',
    isRunning: () => true,
    start: async () => {},
    stop: async () => {},
    consumeOne: async () => null,
    send: async (msg: OutboundMessage) => {
      sentMessages.push(msg);
      if (sendImpl) {
        return await sendImpl(msg);
      }
      return { ok: true, messageId: `reply-${sentMessages.length}` };
    },
    sendMessage: async (msg: OutboundMessage) => {
      sentMessages.push(msg);
      if (sendImpl) {
        return await sendImpl(msg);
      }
      return { ok: true, messageId: `reply-${sentMessages.length}` };
    },
    answerCallback: async () => ({ ok: true }),
    getPreviewCapabilities: () => ({ supported: false, privateOnly: false }),
    sendPreview: async () => 'skip',
  } as unknown as BaseChannelAdapter;
}

type ModelSwitchStore = BridgeStore & {
  bindings: Map<string, ChannelBinding>;
  sessions: Map<string, { id: string; working_directory: string; model: string; system_prompt?: string; provider_id?: string }>;
  sessionModelUpdates: Array<{ sessionId: string; model: string }>;
  dedupKeys: Set<string>;
  auditLogs: AuditLogInput[];
  outboundRefs: OutboundRefInput[];
};

function createModelSwitchStore(settings: Record<string, string> = {}): ModelSwitchStore {
  let sessionCounter = 0;
  const bindings = new Map<string, ChannelBinding>();
  const sessions = new Map<string, { id: string; working_directory: string; model: string; system_prompt?: string; provider_id?: string }>();
  const sessionModelUpdates: Array<{ sessionId: string; model: string }> = [];
  const dedupKeys = new Set<string>();
  const auditLogs: AuditLogInput[] = [];
  const outboundRefs: OutboundRefInput[] = [];
  const scopedPrompts = new Map<string, {
    id: string;
    scopeKey: string;
    channelType: string;
    scopeType: string;
    prompt: string;
    createdAt: string;
    updatedAt: string;
  }>();

  const store: ModelSwitchStore = {
    ...createMinimalStore(settings),
    bindings,
    sessions,
    sessionModelUpdates,
    dedupKeys,
    auditLogs,
    outboundRefs,
    getChannelBinding: (channelType: string, chatId: string, scopeKey?: string) => {
      if (scopeKey) {
        const scoped = bindings.get(`${channelType}:${chatId}:${scopeKey}`);
        if (scoped) return scoped;
      }
      return Array.from(bindings.values()).find((binding) => (
        binding.channelType === channelType && binding.chatId === chatId
      )) || null;
    },
    upsertChannelBinding: (data) => {
      const scopeKey = data.scopeKey || `${data.channelType}:chat:${data.chatId}`;
      const key = `${data.channelType}:${data.chatId}:${scopeKey}`;
      const existing = bindings.get(key);
      const binding: ChannelBinding = {
        id: existing?.id || `binding-${data.channelType}-${data.chatId}`,
        channelType: data.channelType as ChannelBinding['channelType'],
        chatId: data.chatId,
        codepilotSessionId: data.codepilotSessionId,
        sdkSessionId: data.sdkSessionId || existing?.sdkSessionId || '',
        workingDirectory: data.workingDirectory,
        model: data.model,
        mode: (data.mode || existing?.mode || 'code') as ChannelBinding['mode'],
        scopeKey,
        scopeChain: data.scopeChain || existing?.scopeChain || [{ kind: 'chat', id: data.chatId }],
        active: existing?.active ?? true,
        createdAt: existing?.createdAt || '2026-03-16T00:49:08.558Z',
        updatedAt: '2026-03-16T00:49:08.558Z',
      };
      bindings.set(key, binding);
      return binding;
    },
    updateChannelBinding: (id: string, updates: Partial<ChannelBinding>) => {
      for (const [key, binding] of bindings.entries()) {
        if (binding.id === id) {
          bindings.set(key, { ...binding, ...updates });
          return;
        }
      }
    },
    listChannelBindings: (channelType?: ChannelBinding['channelType']) => {
      const all = Array.from(bindings.values());
      if (!channelType) return all;
      return all.filter((binding) => binding.channelType === channelType);
    },
    getScopedSystemPrompt: (scopeKey: string) => scopedPrompts.get(scopeKey) || null,
    upsertScopedSystemPrompt: (data) => {
      const now = new Date().toISOString();
      const existingScoped = scopedPrompts.get(data.scopeKey);
      const next = existingScoped
        ? { ...existingScoped, channelType: data.channelType, scopeType: data.scopeType, prompt: data.prompt, updatedAt: now }
        : {
          id: `scoped-${scopedPrompts.size + 1}`,
          scopeKey: data.scopeKey,
          channelType: data.channelType,
          scopeType: data.scopeType,
          prompt: data.prompt,
          createdAt: now,
          updatedAt: now,
        };
      scopedPrompts.set(data.scopeKey, next);
      return next;
    },
    deleteScopedSystemPrompt: (scopeKey: string) => scopedPrompts.delete(scopeKey),
    listScopedSystemPrompts: (channelType?: string) => {
      const all = Array.from(scopedPrompts.values());
      if (!channelType) return all;
      return all.filter((item) => item.channelType === channelType || item.channelType === 'global');
    },
    getSession: (id: string) => sessions.get(id) || null,
    createSession: (_name: string, model: string, _systemPrompt?: string, cwd?: string) => {
      const sessionId = `session-${++sessionCounter}`;
      const session = {
        id: sessionId,
        working_directory: cwd || '',
        model,
      };
      sessions.set(sessionId, session);
      return session;
    },
    updateSessionModel: (sessionId: string, model: string) => {
      sessionModelUpdates.push({ sessionId, model });
      const session = sessions.get(sessionId);
      if (session) {
        session.model = model;
      }
    },
    checkDedup: (key: string) => dedupKeys.has(key),
    insertDedup: (key: string) => {
      dedupKeys.add(key);
    },
    insertAuditLog: (entry: AuditLogInput) => {
      auditLogs.push(entry);
    },
    insertOutboundRef: (ref: OutboundRefInput) => {
      outboundRefs.push(ref);
    },
  };

  return store;
}

function createMinimalStore(settings: Record<string, string> = {}): BridgeStore {
  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getScopedSystemPrompt: () => null,
    upsertScopedSystemPrompt: () => ({
      id: 'sp-1',
      scopeKey: 'global',
      channelType: 'global',
      scopeType: 'global',
      prompt: '',
      createdAt: '',
      updatedAt: '',
    }),
    deleteScopedSystemPrompt: () => false,
    listScopedSystemPrompts: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
    clearSessionMessages: () => {},
    deleteSession: () => true,
  };
}

describe('bridge-manager /new command', () => {
  it('creates new session and clears old session messages', async () => {
    const messages = new Map<string, any[]>();
    const store = createModelSwitchStore({
      bridge_default_model: 'gpt-5.4',
    }) as any;
    
    store.addMessage = (sessionId: string, role: string, content: string) => {
      const list = messages.get(sessionId) || [];
      list.push({ role, content });
      messages.set(sessionId, list);
    };
    
    store.getMessages = (sessionId: string) => ({
      messages: messages.get(sessionId) || [],
    });
    
    store.clearSessionMessages = (sessionId: string) => {
      messages.delete(sessionId);
    };
    
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue('data: {"type":"text","data":"ok"}\n');
            controller.enqueue('data: {"type":"result","usage":{"input_tokens":1,"output_tokens":1},"is_error":false}\n');
            controller.close();
          },
        }),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createCommandTestAdapter(sentMessages);

    // First message to establish a session
    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-1',
      address: { channelType: 'discord', chatId: 'chat-new-cmd', userId: 'user-1' },
      text: 'hello',
      timestamp: Date.now(),
    });

    const oldBinding = store.getChannelBinding('discord', 'chat-new-cmd');
    assert.ok(oldBinding, 'Should have created initial binding');
    const oldSessionId = oldBinding!.codepilotSessionId;

    // Add some messages to the old session
    store.addMessage(oldSessionId, 'user', 'First message');
    store.addMessage(oldSessionId, 'assistant', 'First response');

    const oldMessages = store.getMessages(oldSessionId);
    assert.equal(oldMessages.messages.length, 4, 'Should have 4 messages in old session (2 from hello + 2 manually added)');

    // Now send /new command
    sentMessages.length = 0;
    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-new',
      address: { channelType: 'discord', chatId: 'chat-new-cmd', userId: 'user-1' },
      text: '/new',
      timestamp: Date.now(),
    });

    // New binding should be created
    const newBinding = store.getChannelBinding('discord', 'chat-new-cmd');
    assert.ok(newBinding, 'Should have new binding');
    assert.notEqual(newBinding!.codepilotSessionId, oldSessionId, 'New session ID should be different');

    // New session should have no messages
    const newMessages = store.getMessages(newBinding!.codepilotSessionId);
    assert.equal(newMessages.messages.length, 0, 'New session should have 0 messages');

    // Response should indicate success
    assert.match(sentMessages[0].text || '', /New session created/);
  });
});
