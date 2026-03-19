import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeStore } from '../../lib/bridge/host';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter';

describe('FeishuAdapter streaming cards', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    mock.restoreAll();
  });

  it('streams card content through the element content API with increasing sequence', async () => {
    initBridgeContext({
      store: createFeishuStore(),
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const fetchCalls: Array<{ input: string; init?: RequestInit }> = [];
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ input: url, init });

      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ tenant_access_token: 'tenant-token', expire: 7200 });
      }
      if (url.includes('/bot/v3/info/')) {
        return jsonResponse({ bot: { open_id: 'bot-open-id', bot_id: 'bot-id' } });
      }
      if (url.includes('/cardkit/v1/cards/card-123/elements/streaming_content/content')) {
        return jsonResponse({ code: 0, msg: 'success' });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const adapter = new FeishuAdapter();
    const cardCreate = mock.fn(async () => ({ data: { card_id: 'card-123' } }));
    const streamingModeSet = mock.fn(async () => ({ code: 0 }));
    const cardUpdate = mock.fn(async () => ({ code: 0 }));
    const messageReply = mock.fn(async () => ({ data: { message_id: 'msg-456' } }));

    (adapter as any).restClient = {
      cardkit: {
        v2: {
          card: {
            create: cardCreate,
            update: cardUpdate,
            settings: { streamingMode: { set: streamingModeSet } },
          },
        },
      },
      im: {
        message: {
          reply: messageReply,
          create: mock.fn(async () => ({ data: { message_id: 'msg-create' } })),
        },
      },
    };
    (adapter as any).appId = 'app-id';
    (adapter as any).appSecret = 'app-secret';

    const created = await (adapter as any).createStreamingCard('chat-1', 'incoming-msg-1');
    assert.equal(created, true);

    adapter.onStreamText('chat-1', '第一段输出');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const streamCall = fetchCalls.find((call) => call.input.includes('/cardkit/v1/cards/card-123/elements/streaming_content/content'));
    assert.ok(streamCall, 'expected element content streaming request');
    assert.equal(streamCall?.init?.method, 'PUT');
    assert.match(String(streamCall?.init?.headers && (streamCall.init.headers as Record<string, string>).Authorization), /Bearer tenant-token/);

    const streamBody = JSON.parse(String(streamCall?.init?.body));
    assert.equal(streamBody.sequence, 1);
    assert.equal(streamBody.content, '第一段输出');

    await adapter.onStreamEnd('chat-1', 'completed', '最终输出');

    assert.equal(cardCreate.mock.calls.length, 1);
    assert.equal(messageReply.mock.calls.length, 1);
    assert.equal(streamingModeSet.mock.calls.length, 1);
    assert.equal(cardUpdate.mock.calls.length, 1);
  });
});

function createFeishuStore(): BridgeStore {
  const settings: Record<string, string> = {
    bridge_feishu_enabled: 'true',
    bridge_feishu_app_id: 'app-id',
    bridge_feishu_app_secret: 'app-secret',
    bridge_feishu_domain: 'feishu',
  };

  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({}) as any,
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
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
