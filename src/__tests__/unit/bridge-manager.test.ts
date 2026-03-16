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
import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeStore, LifecycleHooks } from '../../lib/bridge/host';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { ChannelBinding, OutboundMessage } from '../../lib/bridge/types';

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

describe('bridge-manager model switch commands', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('shows current model and shortcut hints for /model', async () => {
    const store = createModelSwitchStore({
      bridge_default_model: 'claude-sonnet-4-20250514',
      bridge_model_alias_gpt: 'gpt-5',
      bridge_model_alias_codebuddy: 'codebuddy-pro',
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
      address: { channelType: 'qq', chatId: 'chat-1', userId: 'user-1' },
      text: '/model',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].text || '', /Model Switch/);
    assert.match(sentMessages[0].text || '', /Current: <code>claude-sonnet-4-20250514<\/code>/);
    assert.match(sentMessages[0].text || '', /\/gpt → <code>gpt-5<\/code>/);
    assert.match(sentMessages[0].text || '', /\/codebuddy → <code>codebuddy-pro<\/code>/);
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
      address: { channelType: 'qq', chatId: 'chat-1', userId: 'user-1' },
      text: '/model gpt-5',
      timestamp: Date.now(),
    });

    const binding = store.getChannelBinding('qq', 'chat-1');
    assert.ok(binding);
    assert.equal(binding?.model, 'gpt-5');
    assert.equal(binding?.sdkSessionId, '');
    assert.equal(store.sessionModelUpdates.at(-1)?.model, 'gpt-5');
    assert.equal(store.getSession('session-chat-1')?.model, 'gpt-5');
    assert.match(sentMessages[0].text || '', /已切换到模型 <code>gpt-5<\/code>/);
  });

  it('switches model via configured /gpt shortcut', async () => {
    const store = createModelSwitchStore({
      bridge_default_model: 'claude-sonnet-4-20250514',
      bridge_model_alias_gpt: 'gpt-5',
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
      address: { channelType: 'qq', chatId: 'chat-1', userId: 'user-1' },
      text: '/gpt',
      timestamp: Date.now(),
    });

    const binding = store.getChannelBinding('qq', 'chat-1');
    assert.equal(binding?.model, 'gpt-5');
    assert.equal(store.getSession('session-chat-1')?.model, 'gpt-5');
    assert.match(sentMessages[0].text || '', /已通过 <code>\/gpt<\/code> 切换到 <code>gpt-5<\/code>/);
  });
});

function createCommandTestAdapter(sentMessages: OutboundMessage[]): BaseChannelAdapter {
  return {
    channelType: 'qq',
    isRunning: () => true,
    start: async () => {},
    stop: async () => {},
    consumeOne: async () => null,
    send: async (msg: OutboundMessage) => {
      sentMessages.push(msg);
      return { ok: true, messageId: `reply-${sentMessages.length}` };
    },
    sendMessage: async (msg: OutboundMessage) => {
      sentMessages.push(msg);
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
};

function createModelSwitchStore(settings: Record<string, string> = {}): ModelSwitchStore {
  const bindings = new Map<string, ChannelBinding>();
  const sessions = new Map<string, { id: string; working_directory: string; model: string; system_prompt?: string; provider_id?: string }>();
  const sessionModelUpdates: Array<{ sessionId: string; model: string }> = [];

  const store: ModelSwitchStore = {
    ...createMinimalStore(settings),
    bindings,
    sessions,
    sessionModelUpdates,
    getChannelBinding: (channelType: string, chatId: string) => bindings.get(`${channelType}:${chatId}`) || null,
    upsertChannelBinding: (data) => {
      const key = `${data.channelType}:${data.chatId}`;
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
    getSession: (id: string) => sessions.get(id) || null,
    createSession: (_name: string, model: string, _systemPrompt?: string, cwd?: string) => {
      const sessionId = 'session-chat-1';
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
  };
}