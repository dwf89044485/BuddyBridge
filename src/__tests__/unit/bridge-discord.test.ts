import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context.js';
import { DiscordAdapter } from '../../lib/bridge/adapters/discord-adapter.js';
import type { BridgeStore } from '../../lib/bridge/host.js';

function createMockStore(settings: Record<string, string> = {}) {
  const auditLogs: any[] = [];
  const dedupKeys = new Set<string>();

  return {
    auditLogs,
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({}) as any,
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getScopedSystemPrompt: () => null,
    upsertScopedSystemPrompt: () => ({}) as any,
    deleteScopedSystemPrompt: () => false,
    listScopedSystemPrompts: () => [],
    getSession: () => null,
    createSession: () => ({ id: 'session-1', working_directory: '', model: '' }),
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
    insertAuditLog: (entry: any) => { auditLogs.push(entry); },
    checkDedup: (key: string) => dedupKeys.has(key),
    insertDedup: (key: string) => { dedupKeys.add(key); },
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

describe('discord-adapter attachments', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: createMockStore({
        bridge_discord_enabled: 'true',
        bridge_discord_bot_token: 'token',
        bridge_discord_allowed_users: 'user-1',
        bridge_discord_image_enabled: 'false',
      }) as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream<string>() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('enqueues non-image file attachments from Discord messages', async () => {
    const adapter = new DiscordAdapter();

    globalThis.fetch = (async () => new Response(Buffer.from('discord file payload'))) as typeof fetch;

    const attachment = {
      url: 'https://cdn.discordapp.test/file.pdf',
      name: '需求说明.pdf',
      contentType: 'application/pdf',
      size: 128,
    };

    const message = {
      id: 'discord-msg-1',
      author: { id: 'user-1', username: 'tester', bot: false },
      channelId: 'channel-1',
      content: '',
      guild: null,
      attachments: new Map([['att-1', attachment]]),
      channel: { isThread: () => false, name: 'general', parent: null },
      createdTimestamp: Date.now(),
    };

    await (adapter as any).processMessage(message);

    const inbound = (adapter as any).queue.shift();
    assert.ok(inbound, 'should enqueue inbound message');
    assert.equal(inbound.text, '');
    assert.equal(inbound.attachments?.length, 1);
    assert.equal(inbound.attachments?.[0].name, '需求说明.pdf');
    assert.equal(inbound.attachments?.[0].type, 'application/pdf');
    assert.equal(Buffer.from(inbound.attachments?.[0].data, 'base64').toString(), 'discord file payload');
  });
});