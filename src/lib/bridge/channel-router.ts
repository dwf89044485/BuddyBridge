/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import type { ChannelAddress, ChannelBinding, ChannelType, ScopeRef } from './types.js';
import { getBridgeContext } from './context.js';
import { resolveScope } from './scope-utils.js';

function isSameScopeChain(left: ScopeRef[] | undefined, right: ScopeRef[] | undefined): boolean {
  const a = left || [];
  const b = right || [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].kind !== b[i].kind || a[i].id !== b[i].id) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const { store } = getBridgeContext();
  const resolved = resolveScope(
    address.channelType,
    address.chatId,
    address.scopeKey,
    address.scopeChain,
  );

  const existing = store.getChannelBinding(address.channelType, address.chatId, resolved.scopeKey)
    || store.getChannelBinding(address.channelType, address.chatId);
  if (existing) {
    // Verify the linked session still exists; if not, create a new one.
    const session = store.getSession(existing.codepilotSessionId);
    if (!session) {
      // Session was deleted — recreate.
      return createBinding(address);
    }

    const scopeChanged = existing.scopeKey !== resolved.scopeKey
      || !isSameScopeChain(existing.scopeChain, resolved.scopeChain);
    if (!scopeChanged) {
      return existing;
    }

    // Auto-heal stale bindings created before scope-chain fixes.
    return store.upsertChannelBinding({
      channelType: existing.channelType,
      chatId: existing.chatId,
      channelName: address.channelName ?? existing.channelName ?? null,
      parentName: address.parentName ?? existing.parentName ?? null,
      guildName: address.guildName ?? existing.guildName ?? null,
      isThread: address.isThread ?? existing.isThread ?? false,
      scopeKey: resolved.scopeKey,
      scopeChain: resolved.scopeChain,
      codepilotSessionId: existing.codepilotSessionId,
      sdkSessionId: existing.sdkSessionId,
      workingDirectory: existing.workingDirectory,
      model: existing.model,
      mode: existing.mode,
    });
  }
  return createBinding(address);
}

/**
 * Create a new binding with a fresh CodePilot session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const { store } = getBridgeContext();
  const defaultCwd = workingDirectory
    || store.getSetting('bridge_default_work_dir')
    || process.env.HOME
    || '';
  const defaultModel = store.getSetting('bridge_default_model') || '';
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';

  const displayName = address.displayName || address.chatId;
  const session = store.createSession(
    `Bridge: ${displayName}`,
    defaultModel,
    undefined,
    defaultCwd,
    'code',
  );

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  const resolved = resolveScope(
    address.channelType,
    address.chatId,
    address.scopeKey,
    address.scopeChain,
  );

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    channelName: address.channelName ?? null,
    parentName: address.parentName ?? null,
    guildName: address.guildName ?? null,
    isThread: address.isThread ?? false,
    scopeKey: resolved.scopeKey,
    scopeChain: resolved.scopeChain,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory: defaultCwd,
    model: defaultModel,
    mode: 'code',
  });
}

/**
 * Bind an IM chat to an existing CodePilot session.
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
): ChannelBinding | null {
  const { store } = getBridgeContext();
  const session = store.getSession(codepilotSessionId);
  if (!session) return null;

  const resolved = resolveScope(
    address.channelType,
    address.chatId,
    address.scopeKey,
    address.scopeChain,
  );

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    channelName: address.channelName ?? null,
    parentName: address.parentName ?? null,
    guildName: address.guildName ?? null,
    isThread: address.isThread ?? false,
    scopeKey: resolved.scopeKey,
    scopeChain: resolved.scopeChain,
    codepilotSessionId,
    workingDirectory: session.working_directory,
    model: session.model,
  });
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  getBridgeContext().store.updateChannelBinding(id, updates);
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return getBridgeContext().store.listChannelBindings(channelType);
}
