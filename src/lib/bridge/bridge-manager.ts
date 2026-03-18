/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BridgeStatus, ChannelAddress, InboundMessage, OutboundMessage, SendResult, StreamingPreviewState, ToolCallInfo } from './types.js';
import type { ScopeRef } from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import { resolveScope } from './scope-utils.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';

const GLOBAL_KEY = '__bridge_manager__';
const WEEKLY_UPLOAD_REMINDER_DAY = 1;
const WEEKLY_UPLOAD_REMINDER_HOUR = 10;
const WEEKLY_UPLOAD_REMINDER_MINUTE = 0;
const UPLOAD_DIRECTORY_NAME = '.uploads';
const UPLOAD_REMINDER_DEDUP_PREFIX = 'upload-cleanup-reminder';
const UPLOAD_REMINDER_MESSAGE = [
  '检测到当前工作目录下还有已落盘的附件文件。',
  '',
  '请确认这些文件是否还需要保留；如果已经用完，可以考虑清理 `.uploads` 目录。',
  '',
  '如需我处理，可以直接回复：',
  '- 帮我看看 `.uploads` 里有什么',
  '- 帮我清理 `.uploads`',
].join('\n');

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

type ModelShortcutName = 'sonnet' | 'opus' | 'pro' | 'flash' | 'gpt' | 'gpt_code' | 'glm' | 'minimax' | 'kimi';

type ShortcutCommand = '/sonnet' | '/opus' | '/pro' | '/flash' | '/gpt' | '/gpt code' | '/glm' | '/minimax' | '/kimi';

const MODEL_SHORTCUTS: Array<{
  command: ShortcutCommand;
  alias: ModelShortcutName;
  model: string;
}> = [
  { command: '/sonnet', alias: 'sonnet', model: 'claude-sonnet-4.6' },
  { command: '/opus', alias: 'opus', model: 'claude-opus-4.6' },
  { command: '/pro', alias: 'pro', model: 'gemini-3.1-pro' },
  { command: '/flash', alias: 'flash', model: 'gemini-3.1-flash-lite' },
  { command: '/gpt', alias: 'gpt', model: 'gpt-5.4' },
  { command: '/gpt code', alias: 'gpt_code', model: 'gpt-5.3-codex' },
  { command: '/glm', alias: 'glm', model: 'glm-5.0-ioa' },
  { command: '/minimax', alias: 'minimax', model: 'minimax-m2.5-ioa' },
  { command: '/kimi', alias: 'kimi', model: 'kimi-k2.5-ioa' },
];

const RECOMMENDED_MODELS = [
  'claude-sonnet-4.6',
  'claude-opus-4.6',
  'gemini-3.1-pro',
  'gemini-3.1-flash-lite',
  'gpt-5.4',
  'gpt-5.3-codex',
  'glm-5.0-ioa',
  'minimax-m2.5-ioa',
  'kimi-k2.5-ioa',
] as const;

function getModelShortcutSettingKey(alias: ModelShortcutName): string {
  return `bridge_model_alias_${alias}`;
}

function getConfiguredShortcutModel(alias: ModelShortcutName): string | undefined {
  const { store } = getBridgeContext();
  const shortcut = MODEL_SHORTCUTS.find((item) => item.alias === alias);
  const configured = store.getSetting(getModelShortcutSettingKey(alias))?.trim();
  return configured || shortcut?.model;
}

function resolveShortcutModel(
  alias: ModelShortcutName,
): string | undefined {
  return getConfiguredShortcutModel(alias);
}

function isValidModelSelection(input: string): boolean {
  return /^[A-Za-z0-9._:/-]{1,120}$/.test(input);
}

function getAvailableModelList(currentModel?: string | null, defaultModel?: string | null): string[] {
  const candidates = new Set<string>(RECOMMENDED_MODELS);
  if (currentModel?.trim()) candidates.add(currentModel.trim());
  if (defaultModel?.trim()) candidates.add(defaultModel.trim());
  return Array.from(candidates);
}

function buildModelCommandHelp(currentModel?: string | null, defaultModel?: string | null): string {
  const availableModels = getAvailableModelList(currentModel, defaultModel);
  const shortcutByModel = new Map(MODEL_SHORTCUTS.map((item) => [item.model, item.command]));
  const lines = [
    '<b>模型切换</b>',
    '',
    `当前模型：<code>${escapeHtml(currentModel || 'default')}</code>`,
    `默认模型：<code>${escapeHtml(defaultModel || 'runtime default')}</code>`,
    '',
    '直接切换：',
    '<code>/model model_name</code>',
  ];

  lines.push('', '模型列表：');
  for (const model of availableModels) {
    const shortcut = shortcutByModel.get(model);
    if (shortcut) {
      lines.push(`- <code>${escapeHtml(model)}</code>（<code>${escapeHtml(shortcut)}</code>）`);
    } else {
      lines.push(`- <code>${escapeHtml(model)}</code>`);
    }
  }

  lines.push(
    '',
    '选型建议：',
    '- 情绪表达与陪伴 -> <code>/opus</code>、<code>/gpt</code>',
    '  首选 Opus - 想倾诉 / 需要被理解',
    '  次选 GPT - 想要具体建议 / 知道自己要什么',
    '- 亲密关系与人际沟通 -> <code>/opus</code>',
    '- 育儿知识与指引 -> <code>/pro</code>（Gemini Pro）',
    '- 自我认知与成长探索 -> <code>/opus</code>',
    '- 健康咨询与身体管理 -> <code>/pro</code>（Gemini Pro）',
    '- 重大人生决策 -> <code>/opus</code>、<code>/gpt</code>',
    '  首选 Opus - 方向迷茫 / 还没想清楚',
    '  次选 GPT - 方向已有 / 需要梳理验证',
    '',
    '示例：<code>/model kimi-k2.5-ioa</code> 或 <code>/gpt</code>',
  );
  return lines.join('\n');
}

function parseModelShortcutCommand(command: string, args: string): ShortcutCommand | null {
  if (command === '/gpt' && args.toLowerCase() === 'code') {
    return '/gpt code';
  }
  const merged = args ? `${command} ${args.toLowerCase()}` : command;
  return MODEL_SHORTCUTS.some((item) => item.command === merged as ShortcutCommand)
    ? merged as ShortcutCommand
    : null;
}

function buildPromptGuideText(): string {
  return [
    '<b>作用域 Prompt 管理</b>',
    '',
    '切换方式：',
    '1. <code>/prompt set 你的提示词</code> - 设置当前作用域 Prompt',
    '2. <code>/prompt clear</code> - 清空当前作用域 Prompt',
  ].join('\n');
}

function inferScopeType(scopeKey: string): string {
  if (scopeKey === 'global') return 'global';
  if (scopeKey.startsWith('platform:')) return 'platform';
  const parts = scopeKey.split(':');
  return parts[1] || 'chat';
}

function inferChannelTypeForScope(scopeKey: string, fallback: string): string {
  if (scopeKey === 'global') return 'global';
  if (scopeKey.startsWith('platform:')) {
    return scopeKey.slice('platform:'.length) || fallback;
  }
  const parts = scopeKey.split(':');
  return parts[0] || fallback;
}

function resolveAddressScope(address: ChannelAddress): {
  scopeKey: string;
  scopeChain: ScopeRef[];
  inheritedScopeKeys: string[];
} {
  return resolveScope(
    address.channelType,
    address.chatId,
    address.scopeKey,
    address.scopeChain,
  );
}

function parsePromptCommand(args: string): { subcommand: string; content: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { subcommand: '', content: '' };
  }

  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace < 0) {
    return { subcommand: trimmed.toLowerCase(), content: '' };
  }

  const subcommand = trimmed.slice(0, firstSpace).toLowerCase();
  const content = trimmed.slice(firstSpace + 1).trim();
  return { subcommand, content };
}

function buildPromptOverviewText(
  inheritedScopeKeys: string[],
  activeScopeKey: string,
  getPrompt: (scopeKey: string) => string | null,
): string {
  const lines = [
    buildPromptGuideText(),
    '',
    `<b>当前作用域</b>：<code>${escapeHtml(activeScopeKey)}</code>`,
    '',
    '<b>当前命中的作用域配置（从宽到窄）</b>',
  ];

  inheritedScopeKeys.forEach((scopeKey, idx) => {
    const promptText = getPrompt(scopeKey)?.trim() || '';
    const status = promptText ? '已配置' : '未配置';
    lines.push(`${idx + 1}. <code>${escapeHtml(scopeKey)}</code>（${status}）`);
    if (promptText) {
      lines.push(`<pre>${escapeHtml(promptText)}</pre>`);
    }
  });

  return lines.join('\n');
}

// ── Channel-aware rendering dispatch ──────────────────────────

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  weeklyUploadReminderTimer: ReturnType<typeof setTimeout> | null;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      weeklyUploadReminderTimer: null,
      autoStartChecked: false,
    };
  }
  const state = g[GLOBAL_KEY];
  // Backfill sessionLocks for states created before this field existed
  if (!state.sessionLocks) {
    state.sessionLocks = new Map();
  }
  if (state.weeklyUploadReminderTimer === undefined) {
    state.weeklyUploadReminderTimer = null;
  }
  return state;
}

function isMondayTenAm(date: Date): boolean {
  return date.getDay() === WEEKLY_UPLOAD_REMINDER_DAY
    && date.getHours() === WEEKLY_UPLOAD_REMINDER_HOUR
    && date.getMinutes() === WEEKLY_UPLOAD_REMINDER_MINUTE;
}

function getNextWeeklyUploadReminderTime(from: Date): Date {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(WEEKLY_UPLOAD_REMINDER_HOUR, WEEKLY_UPLOAD_REMINDER_MINUTE, 0, 0);

  const dayDiff = (WEEKLY_UPLOAD_REMINDER_DAY - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + dayDiff);

  if (next <= from) {
    next.setDate(next.getDate() + 7);
  }

  return next;
}

function getUploadReminderDedupKey(bindingId: string, when: Date): string {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  const hour = String(when.getHours()).padStart(2, '0');
  const minute = String(when.getMinutes()).padStart(2, '0');
  return `${UPLOAD_REMINDER_DEDUP_PREFIX}:${bindingId}:${year}-${month}-${day}-${hour}${minute}`;
}

function getUploadDirForBinding(binding: import('./types.js').ChannelBinding): string | null {
  const workDir = binding.workingDirectory?.trim();
  if (!workDir) return null;
  return path.join(workDir, UPLOAD_DIRECTORY_NAME);
}

function countUploadFiles(uploadDir: string): number {
  try {
    const entries = fs.readdirSync(uploadDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

async function sendWeeklyUploadReminder(adapter: BaseChannelAdapter, binding: import('./types.js').ChannelBinding, fileCount: number, now: Date): Promise<void> {
  const { store } = getBridgeContext();
  const dedupKey = getUploadReminderDedupKey(binding.id, now);
  if (store.checkDedup(dedupKey)) {
    return;
  }

  const text = `${UPLOAD_REMINDER_MESSAGE}\n\n当前共有 ${fileCount} 个文件。`;
  const result = await deliver(adapter, {
    address: {
      channelType: binding.channelType,
      chatId: binding.chatId,
      channelName: binding.channelName,
      parentName: binding.parentName,
      guildName: binding.guildName,
      isThread: binding.isThread,
      scopeKey: binding.scopeKey,
      scopeChain: binding.scopeChain,
    },
    text,
    parseMode: 'plain',
  }, {
    sessionId: binding.codepilotSessionId,
    dedupKey,
  });

  if (!result.ok) {
    console.warn(`[bridge-manager] Failed to send weekly upload reminder for binding ${binding.id}: ${result.error}`);
  }
}

async function runWeeklyUploadReminderCheck(now: Date = new Date()): Promise<void> {
  if (!isMondayTenAm(now)) {
    return;
  }

  const state = getState();
  const bindings = router.listBindings();
  for (const binding of bindings) {
    if (!binding.active) continue;

    const adapter = state.adapters.get(binding.channelType);
    if (!adapter || !adapter.isRunning()) continue;

    const uploadDir = getUploadDirForBinding(binding);
    if (!uploadDir || !fs.existsSync(uploadDir)) continue;

    const fileCount = countUploadFiles(uploadDir);
    if (fileCount <= 0) continue;

    await sendWeeklyUploadReminder(adapter, binding, fileCount, now);
  }
}

function clearWeeklyUploadReminderTimer(): void {
  const state = getState();
  if (state.weeklyUploadReminderTimer) {
    clearTimeout(state.weeklyUploadReminderTimer);
    state.weeklyUploadReminderTimer = null;
  }
}

function scheduleWeeklyUploadReminder(now: Date = new Date()): void {
  const state = getState();
  clearWeeklyUploadReminderTimer();

  const nextRun = getNextWeeklyUploadReminderTime(now);
  const delay = Math.max(0, nextRun.getTime() - now.getTime());

  state.weeklyUploadReminderTimer = setTimeout(() => {
    runWeeklyUploadReminderCheck(nextRun)
      .catch((err) => {
        console.error('[bridge-manager] Weekly upload reminder failed:', err);
      })
      .finally(() => {
        scheduleWeeklyUploadReminder(new Date(nextRun.getTime() + 1000));
      });
  }, delay);
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  scheduleWeeklyUploadReminder();
  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  clearWeeklyUploadReminderTimer();

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle image-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as { imageDownloadFailed?: boolean; failedCount?: number } | undefined;
    if (rawData?.imageDownloadFailed) {
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} image(s). Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (adapter.channelType === 'feishu' || adapter.channelType === 'qq') {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // ── Streaming card setup (Feishu CardKit v2) ──────────────────
  // If the adapter supports streaming cards (e.g. Feishu), wire up
  // onStreamText, onToolEvent, and onStreamEnd callbacks.
  // These run in parallel with the existing preview system — Feishu
  // uses cards instead of message edit for streaming.
  const hasStreamingCards = typeof adapter.onStreamText === 'function';
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    try { adapter.onStreamText!(msg.address.chatId, fullText); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = hasStreamingCards ? (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      // tool_result doesn't carry name — update existing entry's status
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  } : undefined;

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent);

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    let cardFinalized = false;
    if (hasStreamingCards && adapter.onStreamEnd) {
      try {
        const status = result.hasError ? 'error' : 'completed';
        cardFinalized = await adapter.onStreamEnd(msg.address.chatId, status, result.responseText);
      } catch (err) {
        console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
      }
    }

    // Send response text — render via channel-appropriate format.
    // Skip if streaming card was finalized (content already in card).
    if (result.responseText) {
      if (!cardFinalized) {
        await deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId);
      }
    } else if (result.hasError) {
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, errorResponse);
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // If task was aborted and streaming card is still active, finalize as interrupted
    if (hasStreamingCards && adapter.onStreamEnd && taskAbort.signal.aborted) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();
  const defaultModel = store.getSetting('bridge_default_model') || store.getSetting('default_model') || '';

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
      response = [
        '<b>BuddyBridge</b>',
        '',
        '发送任意消息即可与 Claude 交互。',
        '',
        '/new - 新建会话',
        '/status - 查看当前状态',
        '/stop - 停止当前会话',
        '/cwd /path - 修改工作目录',
        '/mode plan|code|ask - 切换模式',
        '/model - 查看当前模型与快捷切换',
        '/model &lt;name&gt; - 切换到指定模型',
        '/sonnet /opus /pro /flash /gpt /glm /minimax /kimi - 快捷切换模型',
        '/gpt code - 切换到 gpt-5.3-codex',
        '/prompt - 查看和管理作用域 Prompt',
        '/perm allow|allow_session|deny &lt;id&gt; - 响应权限请求',
        // '/new [path] - 新建会话',
        // '/bind &lt;session_id&gt; - 绑定已有会话',
        // '/status - 查看当前状态',
        // '/sessions - 查看最近会话',
        // '/stop - 停止当前会话',
        // '/help - 查看帮助',
      ].join('\n');
      break;

    case '/new': {
      // Abort any running task on the current session before creating a new one
      const oldBinding = router.resolve(msg.address);
      const st = getState();
      const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        st.activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = [
          '请输入工作目录路径',
          '',
          '示例：<code>/cwd /home/user/projects</code>',
        ].join('\n');
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = [
          '请指定模式：plan、code 或 ask',
          '',
          '示例：<code>/mode code</code>',
        ].join('\n');
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/model': {
      const binding = router.resolve(msg.address);
      if (!args) {
        response = buildModelCommandHelp(binding.model, defaultModel);
        break;
      }
      const targetModel = args.trim();
      if (!isValidModelSelection(targetModel)) {
        response = [
          '模型名格式无效。',
          '',
          '仅支持字母、数字以及 <code>.-_:/</code> 这些字符。',
          '示例：<code>/model claude-sonnet-4-20250514</code>',
        ].join('\n');
        break;
      }
      router.updateBinding(binding.id, { model: targetModel, sdkSessionId: '' });
      store.updateSessionModel(binding.codepilotSessionId, targetModel);
      const st = getState();
      const runningHint = st.activeTasks.has(binding.codepilotSessionId)
        ? '\n当前任务不会被中断，新模型会从下一条消息开始生效。'
        : '';
      response = `已切换到模型 <code>${escapeHtml(targetModel)}</code>。${runningHint}`;
      break;
    }

    case '/prompt': {
      const resolvedScope = resolveAddressScope(msg.address);
      const activeScopeKey = resolvedScope.scopeKey;
      const { subcommand, content } = parsePromptCommand(args);

      if (!subcommand || subcommand === 'help') {
        response = buildPromptOverviewText(
          resolvedScope.inheritedScopeKeys,
          activeScopeKey,
          (scopeKey) => store.getScopedSystemPrompt(scopeKey)?.prompt ?? null,
        );
        break;
      }

      if (subcommand === 'set') {
        if (!content) {
          response = [
            '未设置 Prompt 内容。',
            '',
            '请在 <code>/prompt set</code> 后面直接写要设置的提示词。',
            '示例：<code>/prompt set 请在每次回复结尾加上🐢</code>',
          ].join('\n');
          break;
        }

        const scopeType = inferScopeType(activeScopeKey);
        const channelType = inferChannelTypeForScope(activeScopeKey, msg.address.channelType);
        const saved = store.upsertScopedSystemPrompt({
          scopeKey: activeScopeKey,
          channelType,
          scopeType,
          prompt: content,
        });

        response = [
          '已保存当前作用域 Prompt。',
          `作用域：<code>${escapeHtml(saved.scopeKey)}</code>`,
          '',
          '新规则会从下一条消息开始生效。',
        ].join('\n');
        break;
      }

      if (subcommand === 'clear') {
        const deleted = store.deleteScopedSystemPrompt(activeScopeKey);
        if (deleted) {
          response = `已清空当前作用域 Prompt：<code>${escapeHtml(activeScopeKey)}</code>`;
        } else {
          response = `当前作用域尚未配置 Prompt：<code>${escapeHtml(activeScopeKey)}</code>`;
        }
        break;
      }

      response = [
        `未识别的 /prompt 子命令：<code>${escapeHtml(subcommand)}</code>`,
        '',
        '当前仅支持 <code>/prompt</code>、<code>/prompt set</code>、<code>/prompt clear</code>。',
      ].join('\n');
      break;
    }
    case '/sonnet':
    case '/opus':
    case '/pro':
    case '/flash':
    case '/gpt':
    case '/glm':
    case '/minimax':
    case '/kimi': {
      const shortcutCommand = parseModelShortcutCommand(command, args);
      const shortcut = MODEL_SHORTCUTS.find((item) => item.command === shortcutCommand);
      const binding = router.resolve(msg.address);
      const targetModel = shortcut
        ? resolveShortcutModel(shortcut.alias)
        : undefined;
      if (!shortcut || !targetModel) {
        const alias = shortcut?.alias || command.replace('/', '');
        response = [
          `${escapeHtml(command)} 尚未配置具体模型。`,
          '',
          `请直接使用 <code>/model &lt;model_name&gt;</code>，或配置 <code>${escapeHtml(getModelShortcutSettingKey(alias as ModelShortcutName))}</code>。`,
          '配置完成后可用 <code>/model</code> 查看当前快捷映射。',
        ].join('\n');
        break;
      }
      router.updateBinding(binding.id, { model: targetModel, sdkSessionId: '' });
      store.updateSessionModel(binding.codepilotSessionId, targetModel);
      const st = getState();
      const runningHint = st.activeTasks.has(binding.codepilotSessionId)
        ? '\n当前任务不会被中断，新模型会从下一条消息开始生效。'
        : '';
      response = `已通过 <code>${escapeHtml(shortcut.command)}</code> 切换到 <code>${escapeHtml(targetModel)}</code>。${runningHint}`;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
      ].join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      response = [
        '<b>BuddyBridge 命令列表</b>',
        '',
        '/new - 新建会话',
        '/status - 查看当前状态',
        '/stop - 停止当前会话',
        '/cwd /path - 修改工作目录',
        '/mode plan|code|ask - 切换模式',
        '/model - 查看当前模型与快捷切换',
        '/model &lt;name&gt; - 切换到指定模型',
        '/sonnet /opus /pro /flash /gpt /glm /minimax /kimi - 快捷切换模型',
        '/gpt code - 切换到 gpt-5.3-codex',
        '/prompt - 查看和管理作用域 Prompt',
        '/perm allow|allow_session|deny &lt;id&gt; - 响应权限请求',
        // '/new [path] - 新建会话',
        // '/bind &lt;session_id&gt; - 绑定已有会话',
        // '/sessions - 查看最近会话',
        // '1/2/3 - 快捷响应权限请求（飞书/QQ，且仅有一个待处理请求时）',
        // '/help - 查看帮助',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = { handleMessage };

/** @internal */
export const _internals = {
  isMondayTenAm,
  getNextWeeklyUploadReminderTime,
  getUploadReminderDedupKey,
  getUploadDirForBinding,
  countUploadFiles,
  runWeeklyUploadReminderCheck,
  scheduleWeeklyUploadReminder,
  clearWeeklyUploadReminderTimer,
};