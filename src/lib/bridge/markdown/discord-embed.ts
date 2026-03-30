/**
 * Discord Embed builders for interactive command messages.
 *
 * These return raw Embed JSON-compatible objects that the Discord adapter
 * sends via channel.send({ embeds: [embed] }).
 */

import type { ChannelBinding } from '../types.js';

// ── Color Constants ─────────────────────────────────────────────

const COLOR_BLUE = 0x5865F2;   // Blurple
const COLOR_GREEN = 0x57F287;   // Success
const COLOR_RED = 0xED4245;     // Danger
const COLOR_GREY = 0x99AAB5;    // Secondary

// ── /status Embed ──────────────────────────────────────────────

export function buildStatusEmbed(binding: ChannelBinding): Record<string, unknown> {
  return {
    title: '📊 会话状态',
    color: COLOR_BLUE,
    fields: [
      { name: 'Session', value: `\`${binding.codepilotSessionId.slice(0, 8)}...\``, inline: true },
      { name: 'Mode', value: binding.mode, inline: true },
      { name: 'Runtime', value: binding.runtime || 'unknown', inline: true },
      { name: 'Model', value: binding.model || binding.runtime || 'unknown', inline: false },
      { name: 'CWD', value: binding.workingDirectory || '~', inline: false },
    ],
    timestamp: new Date().toISOString(),
  };
}

// ── /mode Embed + Buttons ──────────────────────────────────────

export function buildModeEmbed(
  currentMode: string,
): { embed: Record<string, unknown>; inlineButtons: import('../types.js').InlineButton[][] } {
  const modes = ['plan', 'code', 'ask'] as const;
  const modeLabels: Record<string, string> = { plan: '📋 Plan', code: '💻 Code', ask: '💬 Ask' };

  const buttons = modes.map((mode) => ({
    text: modeLabels[mode],
    callbackData: `cmd:mode:${mode}`,
    style: (mode === currentMode ? 'success' : 'secondary') as 'success' | 'secondary',
  }));

  return {
    embed: {
      title: '⚙️ 切换模式',
      description: `当前模式：**${currentMode.charAt(0).toUpperCase() + currentMode.slice(1)}**`,
      color: COLOR_BLUE,
    },
    inlineButtons: [buttons],
  };
}

// ── /model Embed + Select Menu ──────────────────────────────────

export function buildModelPickerEmbed(
  currentModel: string,
  modelOptions: import('../types.js').SelectMenuOption[],
): { embed: Record<string, unknown>; selectMenu: import('../types.js').SelectMenuConfig } {
  return {
    embed: {
      title: '🤖 模型切换',
      description: `当前模型：**${currentModel || 'default'}**`,
      color: COLOR_BLUE,
    },
    selectMenu: {
      customId: 'select:model',
      placeholder: '选择要切换的模型',
      options: modelOptions,
    },
  };
}

// ── /help Embed ────────────────────────────────────────────────

export function buildHelpEmbed(shortcutLine: string, shortcutExample: string): Record<string, unknown> {
  return {
    title: '📖 BuddyBridge 命令',
    color: COLOR_BLUE,
    fields: [
      {
        name: '💬 会话管理',
        value: '/new - 新建会话\n/status - 查看状态\n/stop - 停止当前任务\n/cwd <path> - 修改工作目录',
        inline: false,
      },
      {
        name: '⚙️ 配置',
        value: '/model - 切换模型\n/mode - 切换模式\n/prompt - 管理 Prompt',
        inline: false,
      },
      {
        name: '🤖 快捷切换模型',
        value: `${shortcutLine}\n${shortcutExample}`,
        inline: false,
      },
    ],
  };
}

