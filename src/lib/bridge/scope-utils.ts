import type { ScopeRef } from './types.js';

export interface ResolvedScope {
  scopeKey: string;
  scopeChain: ScopeRef[];
  inheritedScopeKeys: string[];
}

const DEFAULT_SCOPE_KIND = 'chat';

function normalizeScopeRef(scope: ScopeRef): ScopeRef | null {
  const kind = String(scope?.kind || '').trim();
  const id = String(scope?.id || '').trim();
  if (!kind || !id) return null;
  return { kind, id };
}

export function normalizeScopeChain(scopeChain: ScopeRef[] | undefined, chatId: string): ScopeRef[] {
  if (!scopeChain || scopeChain.length === 0) {
    return [{ kind: DEFAULT_SCOPE_KIND, id: chatId }];
  }

  const normalized = scopeChain
    .map(normalizeScopeRef)
    .filter((scope): scope is ScopeRef => Boolean(scope));

  if (normalized.length === 0) {
    return [{ kind: DEFAULT_SCOPE_KIND, id: chatId }];
  }

  return normalized;
}

export function buildInheritedScopeKeys(channelType: string, scopeChain: ScopeRef[], chatId: string): string[] {
  const keys = ['global', `platform:${channelType}`];

  if (scopeChain.length === 0) {
    keys.push(`${channelType}:${DEFAULT_SCOPE_KIND}:${chatId}`);
    return keys;
  }

  for (const scope of scopeChain) {
    keys.push(`${channelType}:${scope.kind}:${scope.id}`);
  }

  return keys;
}

export function resolveScope(
  channelType: string,
  chatId: string,
  scopeKey?: string,
  scopeChain?: ScopeRef[],
): ResolvedScope {
  const normalizedScopeChain = normalizeScopeChain(scopeChain, chatId);
  const inheritedScopeKeys = buildInheritedScopeKeys(channelType, normalizedScopeChain, chatId);
  const normalizedScopeKey = scopeKey?.trim() || inheritedScopeKeys[inheritedScopeKeys.length - 1];

  if (!inheritedScopeKeys.includes(normalizedScopeKey)) {
    inheritedScopeKeys.push(normalizedScopeKey);
  }

  return {
    scopeKey: normalizedScopeKey,
    scopeChain: normalizedScopeChain,
    inheritedScopeKeys,
  };
}

export function inferScopeType(scopeKey: string): string {
  if (scopeKey === 'global') return 'global';
  if (scopeKey.startsWith('platform:')) return 'platform';

  const parts = scopeKey.split(':');
  if (parts.length >= 2) {
    return parts[1] || DEFAULT_SCOPE_KIND;
  }
  return DEFAULT_SCOPE_KIND;
}

export function formatScopeRuleTitle(scopeKey: string): string {
  if (scopeKey === 'global') {
    return '全局规则';
  }

  if (scopeKey.startsWith('platform:')) {
    const platform = scopeKey.slice('platform:'.length) || 'unknown';
    return `平台规则（${platform}）`;
  }

  const parts = scopeKey.split(':');
  const scopeType = parts[1] || DEFAULT_SCOPE_KIND;
  const scopeId = parts.slice(2).join(':');

  const typeLabelMap: Record<string, string> = {
    guild: '群组规则',
    channel: '频道规则',
    thread: '子区规则',
    chat: '会话规则',
  };

  const typeLabel = typeLabelMap[scopeType] || `${scopeType}规则`;
  return scopeId ? `${typeLabel}（${scopeId}）` : typeLabel;
}
