import type { ToolCallInfo } from '../types.js';

/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 *
 * Schema 2.0 cards render code blocks, tables, bold, italic, links properly.
 * Post messages with md tag render bold, italic, inline code, links.
 */

/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export function hasComplexMarkdown(text: string): boolean {
  // Fenced code blocks
  if (/```[\s\S]*?```/.test(text)) return true;
  // Tables: header row followed by separator row with pipes and dashes
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Preprocess markdown for Feishu rendering.
 * Only ensures code fences have a newline before them.
 * Does NOT touch the text after ``` to preserve language tags like ```python.
 */
export function preprocessFeishuMarkdown(text: string): string {
  // Ensure ``` has newline before it (unless at start of text)
  return text.replace(/([^\n])```/g, '$1\n```');
}

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, tables, bold, italic, links, inline code properly.
 * Aligned with Openclaw's buildMarkdownCard().
 */
export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  });
}

/**
 * Build Feishu post message content (msg_type: 'post') with md tag.
 * Used for simple text without code blocks or tables.
 * Aligned with Openclaw's buildFeishuPostMessagePayload().
 */
export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

/**
 * Convert simple HTML (from command responses) to markdown for Feishu.
 * Handles common tags: <b>, <i>, <code>, <br>, entities.
 */
export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build tool progress markdown lines.
 * Each tool shows an icon based on status: 🔄 Running, ✅ Complete, ❌ Error.
 */
export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((tc) => {
    const icon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
    return `${icon} \`${tc.name}\``;
  });
  return lines.join('\n');
}

/**
 * Format elapsed time for card footer.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

/**
 * Build the body elements array for a streaming card update.
 * Combines main text content with tool progress.
 */
export function buildStreamingContent(text: string, tools: ToolCallInfo[]): string {
  let content = text || '';
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }
  return content || '💭 Thinking...';
}

/**
 * Build the final card JSON (schema 2.0) with text, tool progress, and footer.
 */
export function buildFinalCardJson(
  text: string,
  tools: ToolCallInfo[],
  footer: { status: string; elapsed: string } | null,
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Main text content
  let content = preprocessFeishuMarkdown(text);
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }

  if (content) {
    elements.push({
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  // Footer
  if (footer) {
    const parts: string[] = [];
    if (footer.status) parts.push(footer.status);
    if (footer.elapsed) parts.push(footer.elapsed);
    if (parts.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: parts.join(' · '),
        text_size: 'notation',
      });
    }
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  });
}

/**
 * Build a permission card with real action buttons (column_set layout).
 * Structure aligned with CodePilot's working Feishu outbound implementation.
 * Returns the card JSON string for msg_type: 'interactive'.
 */
export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
): string {
  const buttons = [
    { label: 'Allow', type: 'primary', action: 'allow' },
    { label: 'Allow Session', type: 'default', action: 'allow_session' },
    { label: 'Deny', type: 'danger', action: 'deny' },
  ];

  const buttonColumns = buttons.map((btn) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type,
      size: 'medium',
      value: { callback_data: `perm:${btn.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
    }],
  }));

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Permission Required' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: text, text_size: 'normal' },
        { tag: 'markdown', content: '⏱ This request will expire in 5 minutes', text_size: 'notation' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: buttonColumns,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: 'Or reply: `1` Allow · `2` Allow Session · `3` Deny',
          text_size: 'notation',
        },
      ],
    },
  });
}

// ── Interactive Command Cards ───────────────────────────────────

export function buildStatusCard(
  binding: { codepilotSessionId: string; workingDirectory: string; model: string; mode: string; runtime?: string; taskStatus?: string },
  modelOptions?: Array<{ label: string; value: string }>,
  runtimeOptions?: Array<{ label: string; value: string }>,
  promptInfo?: { activeScopeKey: string; effectiveScopeKey: string | null; hasEffectivePrompt: boolean },
): Record<string, unknown> {
  const modeButtons = (['plan', 'code', 'ask'] as const).map((mode) => ({
    tag: 'button' as const,
    text: { tag: 'plain_text' as const, content: mode.toUpperCase() },
    type: mode === binding.mode ? 'primary' as const : 'default' as const,
    value: { callback_data: `cmd:mode:${mode}`, chatId: '' },
  }));

  const promptButtons = [
    {
      tag: 'button' as const,
      text: { tag: 'plain_text' as const, content: '设置 Prompt' },
      type: 'primary' as const,
      value: { callback_data: 'cmd:prompt:set', chatId: '' },
    },
    {
      tag: 'button' as const,
      text: { tag: 'plain_text' as const, content: '查看 Prompt' },
      type: 'default' as const,
      value: { callback_data: 'cmd:prompt:show', chatId: '' },
    },
    {
      tag: 'button' as const,
      text: { tag: 'plain_text' as const, content: '清空 Prompt' },
      type: 'default' as const,
      value: { callback_data: 'cmd:prompt:clear', chatId: '' },
    },
  ];

  const modelSelect = modelOptions && modelOptions.length > 0
    ? {
      tag: 'select_static' as const,
      placeholder: '选择要切换的模型',
      options: modelOptions.map((m) => ({ text: m.label, value: `cmd:model:${m.value}` })),
    }
    : null;

  const runtimeSelect = runtimeOptions && runtimeOptions.length > 0
    ? {
      tag: 'select_static' as const,
      placeholder: '选择要切换的 Runtime',
      options: runtimeOptions.map((m) => ({ text: m.label, value: `cmd:runtime:${m.value}` })),
    }
    : null;

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📊 会话状态' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            '**Session**',
            `Session ID: \`${binding.codepilotSessionId}\``,
            `Runtime: ${binding.runtime || 'unknown'}`,
            `CWD: ${binding.workingDirectory || '~'}`,
          ].join('\n'),
        },
        {
          tag: 'markdown',
          content: [
            '**Model**',
            `Current Model: ${binding.model || binding.runtime || 'unknown'}`,
          ].join('\n'),
        },
        ...(modelSelect ? [modelSelect] : []),
        {
          tag: 'markdown',
          content: [
            '**Runtime**',
            `Current Runtime: ${binding.runtime || 'unknown'}`,
          ].join('\n'),
        },
        ...(runtimeSelect ? [runtimeSelect] : []),
        {
          tag: 'markdown',
          content: [
            '**Mode**',
            `Current Mode: ${binding.mode}`,
          ].join('\n'),
        },
        { tag: 'action', actions: modeButtons },
        {
          tag: 'markdown',
          content: [
            '**Prompt**',
            `Active Scope: \`${promptInfo?.activeScopeKey || 'unknown'}\``,
            `Prompt Source: \`${promptInfo?.effectiveScopeKey || 'none'}\``,
            `Prompt Status: ${promptInfo?.hasEffectivePrompt ? '已配置' : '未配置'}`,
          ].join('\n'),
        },
        { tag: 'action', actions: promptButtons },
      ],
    },
  };
}

export function buildModeCard(currentMode: string): Record<string, unknown> {
  const modes = ['plan', 'code', 'ask', 'bypass'] as const;
  const modeLabels: Record<string, string> = { plan: '📋 Plan', code: '💻 Code', ask: '💬 Ask', bypass: '🔓 Bypass' };

  const buttons = modes.map((mode) => ({
    tag: 'button' as const,
    text: { tag: 'plain_text' as const, content: modeLabels[mode] },
    type: mode === currentMode ? 'primary' as const : 'default' as const,
    value: { callback_data: `cmd:mode:${mode}`, chatId: '' },
  }));

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⚙️ 切换模式' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `当前模式：**${currentMode.charAt(0).toUpperCase() + currentMode.slice(1)}**\n\n选择新模式：`,
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: buttons,
        },
      ],
    },
  };
}

export function buildModelPickerCard(
  currentModel: string,
  modelOptions: Array<{ label: string; value: string }>,
): Record<string, unknown> {
  const options = modelOptions.map((m) => ({
    text: m.label,
    value: `cmd:model:${m.value}`,
  }));

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 模型切换' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `当前模型：**${currentModel || 'unknown'}**\n\n选择要切换的模型：`,
        },
        { tag: 'hr' },
        {
          tag: 'select_static',
          placeholder: '选择模型',
          options,
        },
      ],
    },
  };
}

export function buildHelpCard(shortcutLine: string, shortcutExample: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📖 BuddyBridge 命令' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            '**💬 会话管理**',
            '`/new` - 新建会话  `/status` - 查看状态  `/stop` - 停止任务  `/cwd` - 修改目录',
            '',
            '**⚙️ 配置**',
            '`/model` - 切换模型  `/mode` - 切换模式  `/prompt` - 管理 Prompt',
            '',
            '**🤖 快捷切换模型**',
            shortcutLine,
            shortcutExample,
          ].join('\n'),
        },
      ],
    },
  };
}
