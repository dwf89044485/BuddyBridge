/**
 * Discord Adapter — implements BaseChannelAdapter for Discord Bot API.
 *
 * Uses discord.js v14 Client with Gateway intents for real-time message
 * consumption, and REST API for message sending. Routes messages through
 * an internal async queue (same pattern as Telegram and Feishu).
 *
 * IMPORTANT: discord.js is loaded via dynamic import() to avoid Next.js
 * bundler trying to resolve native modules (zlib-sync, bufferutil) at
 * build time. All discord.js types are referenced via `any` at the class
 * level and resolved at runtime in start().
 */

import crypto from 'crypto';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../types.js';
import type { FileAttachment } from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';

/** Max number of message IDs to keep for dedup. */
const DEDUP_MAX = 1000;

/** Discord message character limit. */
const DISCORD_CHAR_LIMIT = 2000;

/** Default max attachment download size (20 MB). */
const DEFAULT_MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

/** Typing indicator interval (8s, Discord typing lasts ~10s). */
const TYPING_INTERVAL_MS = 8000;

/** Presence refresh interval (5 min) to keep bot status alive across reconnects. */
const PRESENCE_REFRESH_MS = 5 * 60 * 1000;

/** Interaction TTL for answerCallback (60s). */
const INTERACTION_TTL_MS = 60_000;

/** Map our style names to discord.js ButtonStyle constants. Falls back to Primary. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapButtonStyle(style?: string): any {
  if (!discordJs) return 1; // fallback
  const { ButtonStyle } = discordJs;
  switch (style) {
    case 'success': return ButtonStyle.Success;
    case 'danger': return ButtonStyle.Danger;
    case 'secondary': return ButtonStyle.Secondary;
    default: return ButtonStyle.Primary;
  }
}

/**
 * Lazily loaded discord.js module reference.
 * Populated in start() via dynamic import to avoid bundler issues.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let discordJs: any = null;

async function loadDiscordJs() {
  if (!discordJs) {
    discordJs = await import('discord.js');
  }
  return discordJs;
}

export class DiscordAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'discord';

  private running = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private seenMessageIds = new Set<string>();
  private botUserId: string | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  /** Temporary storage for Interaction objects (for answerCallback). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingInteractions = new Map<string, { interaction: any; expiresAt: number }>();
  /** Preview: store message IDs per chat for edit-based streaming. */
  private previewMessages = new Map<string, string>();
  /** Chats where preview has permanently failed. */
  private previewDegraded = new Set<string>();
  /** Interval for periodic presence refresh. */
  private presenceRefreshInterval: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[discord-adapter] Cannot start:', configError);
      return;
    }

    const token = getBridgeContext().store.getSetting('bridge_discord_bot_token') || '';

    // Dynamic import to avoid bundler resolving native modules
    const djs = await loadDiscordJs();
    const { Client, GatewayIntentBits, Partials } = djs;

    const { ActivityType } = djs;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
      // Set initial presence in IDENTIFY payload so Gateway knows we are online from the start
      presence: {
        activities: [{ name: 'BuddyBridge', type: ActivityType.Playing }],
        status: 'online',
      },
    });

    // Register event handlers before login
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.on('messageCreate', (message: any) => {
      this.handleMessageCreate(message).catch((err: unknown) => {
        console.error('[discord-adapter] messageCreate error:', err instanceof Error ? err.message : err);
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.on('interactionCreate', (interaction: any) => {
      this.handleInteraction(interaction).catch((err: unknown) => {
        console.error('[discord-adapter] interactionCreate error:', err instanceof Error ? err.message : err);
      });
    });

    // Login and wait for ready
    await this.client.login(token);

    // Wait for the ready event
    await new Promise<void>((resolve) => {
      if (this.client!.isReady()) {
        resolve();
      } else {
        this.client!.once('ready', () => resolve());
      }
    });

    this.botUserId = this.client.user?.id || null;

    // Refresh bot presence and start periodic refresh to survive reconnects
    this.refreshPresence();
    this.presenceRefreshInterval = setInterval(() => this.refreshPresence(), PRESENCE_REFRESH_MS);

    try {
      await this.registerSlashCommands();
    } catch (err) {
      console.warn('[discord-adapter] Slash command registration failed:', err instanceof Error ? err.message : err);
    }

    this.running = true;

    console.log('[discord-adapter] Started (botUserId:', this.botUserId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Stop presence refresh
    if (this.presenceRefreshInterval) {
      clearInterval(this.presenceRefreshInterval);
      this.presenceRefreshInterval = null;
    }

    // Destroy client
    if (this.client) {
      try {
        this.client.destroy();
      } catch (err) {
        console.warn('[discord-adapter] Client destroy error:', err instanceof Error ? err.message : err);
      }
      this.client = null;
    }

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Stop all typing indicators
    for (const [, interval] of this.typingIntervals) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Clear state
    this.seenMessageIds.clear();
    this.pendingInteractions.clear();
    this.previewMessages.clear();
    this.previewDegraded.clear();

    console.log('[discord-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Push presence update via Gateway to keep bot shown as online. */
  private refreshPresence(): void {
    try {
      this.client?.user?.setPresence?.({
        activities: [{ name: 'BuddyBridge', type: 0 }],
        status: 'online',
      });
    } catch (err) {
      console.warn('[discord-adapter] Failed to refresh presence:', err instanceof Error ? err.message : err);
    }
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Typing indicator ───────────────────────────────────────

  onMessageStart(chatId: string): void {
    this.stopTyping(chatId);
    if (!this.client) return;

    const sendTyping = () => {
      const channel = this.client?.channels.cache.get(chatId);
      if (channel && 'sendTyping' in channel) {
        channel.sendTyping().catch(() => {});
      }
    };

    // Send immediately
    sendTyping();

    // Repeat every 8s
    const interval = setInterval(sendTyping, TYPING_INTERVAL_MS);
    this.typingIntervals.set(chatId, interval);
  }

  onMessageEnd(chatId: string): void {
    this.stopTyping(chatId);
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.client) {
      return { ok: false, error: 'Discord client not initialized' };
    }

    let channel = this.client.channels.cache.get(message.address.chatId);
    if (!channel || !('send' in channel)) {
      // Try fetching the channel if not in cache
      try {
        channel = await this.client.channels.fetch(message.address.chatId);
        if (!channel || !('send' in channel)) {
          return { ok: false, error: 'Channel not found or not sendable' };
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Channel fetch failed' };
      }
    }

    return this.sendToChannel(channel, message);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async sendToChannel(channel: any, message: OutboundMessage): Promise<SendResult> {
    try {
      let text = message.text;

      // Convert HTML to Discord markdown
      if (message.parseMode === 'HTML') {
        text = this.htmlToDiscordMarkdown(text);
      }
      // Markdown passes through natively

      // Build message options
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: { content?: string; embeds?: any[]; components?: any[]; flags?: number } = {};
      let autoWrappedInteractiveEmbed = false;
      let usedComponentsV2 = false;

      // Discord Embed
      if (message.embed) {
        options.embeds = [message.embed];
      }

      // Content (skip if embed-only)
      if (text) {
        options.content = text.slice(0, DISCORD_CHAR_LIMIT);
      }

      // Build components (buttons + select menus)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const components: any[] = [];

      if (message.inlineButtons && message.inlineButtons.length > 0 && discordJs) {
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = discordJs;
        for (const row of message.inlineButtons) {
          const actionRow = new ActionRowBuilder();
          for (const btn of row) {
            const style = mapButtonStyle(btn.style);
            actionRow.addComponents(
              new ButtonBuilder()
                .setCustomId(btn.callbackData)
                .setLabel(btn.text)
                .setStyle(style),
            );
          }
          components.push(actionRow);
        }
      }

      if (message.selectMenu && discordJs) {
        const { ActionRowBuilder, StringSelectMenuBuilder } = discordJs;
        const menu = new StringSelectMenuBuilder()
          .setCustomId(message.selectMenu.customId)
          .setPlaceholder(message.selectMenu.placeholder ?? 'Select an option');
        for (const opt of message.selectMenu.options) {
          const entry: { label: string; value: string; description?: string } = { label: opt.label, value: opt.value };
          if (opt.description) entry.description = opt.description;
          menu.addOptions(entry);
        }
        components.push(new ActionRowBuilder().addComponents(menu));
      }

      if (components.length > 0) {
        options.components = components;

        // Prefer Components V2 container layout for a more card-like unified block.
        if (!options.embeds && options.content && discordJs?.MessageFlags?.IsComponentsV2) {
          const classicRows = components
            .map((row: any) => (typeof row?.toJSON === 'function' ? row.toJSON() : row))
            .filter(Boolean);
          options.flags = discordJs.MessageFlags.IsComponentsV2;
          options.components = [
            {
              type: 17, // CONTAINER
              components: [
                { type: 10, content: options.content }, // TEXT_DISPLAY
                ...classicRows,
              ],
            },
          ];
          delete options.content;
          usedComponentsV2 = true;
        }

        // Fallback layout (legacy): wrap interactive text into an embed.
        // Only auto-wrap when caller didn't provide a custom embed.
        if (!usedComponentsV2 && !options.embeds && options.content && discordJs?.EmbedBuilder) {
          const { EmbedBuilder } = discordJs;
          options.embeds = [new EmbedBuilder().setDescription(options.content)];
          delete options.content;
          autoWrappedInteractiveEmbed = true;
        }
      }

      try {
        const sent = await channel.send(options);
        return { ok: true, messageId: sent.id };
      } catch (err) {
        // Fallback #1: Components V2 failed, retry with classic content + components.
        if (usedComponentsV2 && text) {
          try {
            const classicRows = components
              .map((row: any) => (typeof row?.toJSON === 'function' ? row.toJSON() : row))
              .filter(Boolean);
            const fallbackOptions: { content?: string; components?: any[] } = {
              content: text.slice(0, DISCORD_CHAR_LIMIT),
              components: classicRows,
            };
            const sentFallback = await channel.send(fallbackOptions);
            return { ok: true, messageId: sentFallback.id };
          } catch (fallbackErr) {
            return { ok: false, error: fallbackErr instanceof Error ? fallbackErr.message : 'Send failed' };
          }
        }

        // Fallback #2: auto-wrapped embed failed, retry with plain content + components.
        if (autoWrappedInteractiveEmbed && text) {
          try {
            const fallbackOptions: { content?: string; components?: any[] } = {
              content: text.slice(0, DISCORD_CHAR_LIMIT),
              components: options.components,
            };
            const sentFallback = await channel.send(fallbackOptions);
            return { ok: true, messageId: sentFallback.id };
          } catch (fallbackErr) {
            return { ok: false, error: fallbackErr instanceof Error ? fallbackErr.message : 'Send failed' };
          }
        }
        return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    const entry = this.pendingInteractions.get(callbackQueryId);
    if (!entry) return;

    this.pendingInteractions.delete(callbackQueryId);

    const interaction = entry.interaction;
    const feedback = text || 'OK';
    let cleared = false;

    // Components V2 message cannot include content while editing components.
    try {
      if (interaction.message?.editable) {
        await interaction.message.edit({ components: [] });
        cleared = true;
      }
    } catch (err) {
      console.warn('[discord-adapter] message.edit failed, falling back to editReply:', err instanceof Error ? err.message : err);
    }

    try {
      if (!cleared && (interaction.deferred || interaction.replied)) {
        await interaction.editReply({ components: [] });
        cleared = true;
      }
    } catch (err) {
      console.warn('[discord-adapter] editReply fallback failed:', err instanceof Error ? err.message : err);
    }

    // Send explicit success feedback as a separate message.
    try {
      if (feedback.trim()) {
        if (typeof interaction.followUp === 'function') {
          await interaction.followUp({ content: feedback });
        } else if (interaction.channel?.send) {
          await interaction.channel.send({ content: feedback });
        }
      }
    } catch (err) {
      console.warn('[discord-adapter] followUp feedback failed:', err instanceof Error ? err.message : err);
    }
  }

  // ── Streaming preview ──────────────────────────────────────

  getPreviewCapabilities(chatId: string): PreviewCapabilities | null {
    // Global kill switch
    if (getBridgeContext().store.getSetting('bridge_discord_stream_enabled') === 'false') return null;

    // Already degraded for this chat
    if (this.previewDegraded.has(chatId)) return null;

    return { supported: true, privateOnly: false };
  }

  async sendPreview(chatId: string, text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.client) return 'skip';

    const existingMsgId = this.previewMessages.get(chatId);

    try {
      if (existingMsgId) {
        // Edit existing preview message
        const channel = await this.client.channels.fetch(chatId);
        if (!channel || !('messages' in channel)) return 'skip';

        const msg = await channel.messages.fetch(existingMsgId);
        await msg.edit(text.slice(0, DISCORD_CHAR_LIMIT));
        return 'sent';
      } else {
        // Send new preview message
        const channel = await this.client.channels.fetch(chatId);
        if (!channel || !('send' in channel)) return 'skip';

        const sent = await channel.send(text.slice(0, DISCORD_CHAR_LIMIT));
        this.previewMessages.set(chatId, sent.id);
        return 'sent';
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (err as any)?.httpStatus;
      if (code === 403 || code === 404) {
        this.previewDegraded.add(chatId);
        return 'degrade';
      }
      return 'skip';
    }
  }

  endPreview(chatId: string, _draftId: number): void {
    const msgId = this.previewMessages.get(chatId);
    if (msgId && this.client) {
      // Delete the preview message — the final response replaces it
      const channel = this.client.channels.cache.get(chatId);
      if (channel && 'messages' in channel) {
        channel.messages.fetch(msgId).then((msg: { delete: () => void }) => msg.delete()).catch(() => {});
      }
    }
    this.previewMessages.delete(chatId);
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const enabled = getBridgeContext().store.getSetting('bridge_discord_enabled');
    if (enabled !== 'true') return 'bridge_discord_enabled is not true';

    const token = getBridgeContext().store.getSetting('bridge_discord_bot_token');
    if (!token) return 'bridge_discord_bot_token not configured';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_discord_allowed_users') || '';
    const allowedChannels = getBridgeContext().store.getSetting('bridge_discord_allowed_channels') || '';

    // If both are empty, allow all (matches Telegram/Feishu usability defaults).
    // Operators can still restrict access via allowed users/channels settings.
    if (!allowedUsers && !allowedChannels) return true;

    const users = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
    const channels = allowedChannels.split(',').map(s => s.trim()).filter(Boolean);

    // If users list is configured, check if user is in it
    if (users.length > 0 && users.includes(userId)) return true;

    // If channels list is configured, check if chat is in it
    if (channels.length > 0 && channels.includes(chatId)) return true;

    // If only one list is configured and the other is empty, check only the configured one
    if (users.length > 0 && channels.length === 0) return false;
    if (channels.length > 0 && users.length === 0) return false;

    return false;
  }

  // ── Incoming event handlers ────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleMessageCreate(message: any): Promise<void> {
    try {
      await this.processMessage(message);
    } catch (err) {
      console.error(
        '[discord-adapter] Unhandled error in message handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processMessage(message: any): Promise<void> {
    // Filter out bot messages (including self)
    if (message.author.bot) return;
    if (this.botUserId && message.author.id === this.botUserId) return;

    // Dedup by message ID
    if (this.seenMessageIds.has(message.id)) return;
    this.addToDedup(message.id);

    const chatId = message.channelId;
    const userId = message.author.id;
    const displayName = message.author.username || message.author.id;
    const isGuild = !!message.guild;

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) return;

    // Guild (server) message policy
    if (isGuild) {
      const allowedGuilds = (getBridgeContext().store.getSetting('bridge_discord_allowed_guilds') || '')
        .split(',').map(s => s.trim()).filter(Boolean);

      if (allowedGuilds.length > 0 && !allowedGuilds.includes(message.guild!.id)) {
        return;
      }

      const policy = getBridgeContext().store.getSetting('bridge_discord_group_policy') || 'open';

      if (policy === 'disabled') {
        return;
      }

      // Require @mention check
      const requireMention = getBridgeContext().store.getSetting('bridge_discord_require_mention') === 'true';
      if (requireMention && this.botUserId) {
        // Check both user @mention and role @mention (bot's managed role)
        const userMentioned = message.mentions.users.has(this.botUserId);
        const botMember = message.guild?.members?.cache?.get(this.botUserId);
        const botRoles = botMember?.roles?.cache;
        const roleMentioned = botRoles
          ? message.mentions.roles.some((r: { id: string }) => botRoles.has(r.id))
          : false;
        // Also check raw content for <@botId> or <@&roleId> patterns
        const rawContentMention = message.content?.includes(`<@${this.botUserId}>`)
          || message.content?.includes(`<@!${this.botUserId}>`);
        const mentioned = userMentioned || roleMentioned || rawContentMention;
        if (!mentioned) {
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'discord',
              chatId,
              direction: 'inbound',
              messageId: message.id,
              summary: '[FILTERED] Guild message dropped: bot not @mentioned (require_mention=true)',
            });
          } catch { /* best effort */ }
          return;
        }
      }
    }

    // Extract text content
    let text = message.content || '';

    // Strip bot user mention and bot role mention from text
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '').trim();
    }
    // Strip bot's managed role mentions
    if (message.guild && this.botUserId) {
      const botMember = message.guild.members?.cache?.get(this.botUserId);
      if (botMember?.roles?.cache) {
        for (const [roleId] of botMember.roles.cache) {
          text = text.replace(new RegExp(`<@&${roleId}>`, 'g'), '').trim();
        }
      }
    }

    // Normalize ! commands to / commands
    if (text.startsWith('!')) {
      text = '/' + text.slice(1);
    }

    // Handle attachments
    const attachments: FileAttachment[] = [];
    const imageEnabled = getBridgeContext().store.getSetting('bridge_discord_image_enabled') !== 'false';
    const maxSize = parseInt(getBridgeContext().store.getSetting('bridge_discord_max_attachment_size') || '', 10) || DEFAULT_MAX_ATTACHMENT_SIZE;

    if (message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        const contentType = attachment.contentType || 'application/octet-stream';
        const isImage = contentType.startsWith('image/');

        if (isImage && !imageEnabled) continue;
        if (attachment.size > maxSize) {
          console.warn(`[discord-adapter] Attachment too large (${attachment.size} > ${maxSize}), skipping`);
          continue;
        }

        try {
          const res = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) continue;

          const buffer = Buffer.from(await res.arrayBuffer());
          const base64 = buffer.toString('base64');
          const id = crypto.randomUUID();

          attachments.push({
            id,
            name: attachment.name || (isImage ? `image.${contentType.split('/')[1] || 'png'}` : 'attachment'),
            type: contentType,
            size: buffer.length,
            data: base64,
          });
        } catch (err) {
          console.warn('[discord-adapter] Attachment download failed:', err instanceof Error ? err.message : err);
        }
      }
    }

    if (!text.trim() && attachments.length === 0) return;

    const isThread = Boolean(message.channel?.isThread?.());
    const parentChannelId = (message.channel?.parentId || message.channel?.parent?.id) as string | undefined;

    const scopeChain = isGuild
      ? [
        { kind: 'guild', id: message.guild.id as string },
        ...(isThread && parentChannelId ? [{ kind: 'channel', id: parentChannelId as string }] : []),
        { kind: isThread ? 'thread' : 'channel', id: chatId as string },
      ]
      : [{ kind: 'chat', id: chatId as string }];

    const address = {
      channelType: 'discord' as const,
      chatId,
      userId,
      displayName,
      channelName: (message.channel as { name?: string } | null | undefined)?.name ?? null,
      parentName: (message.channel?.parent as { name?: string } | null | undefined)?.name ?? null,
      guildName: message.guild?.name ?? null,
      isThread,
      scopeChain,
    };

    const inbound: InboundMessage = {
      messageId: message.id,
      address,
      text: text.trim(),
      timestamp: message.createdTimestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: 'discord',
        chatId,
        direction: 'inbound',
        messageId: message.id,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueue(inbound);
  }

  private async registerSlashCommands(): Promise<void> {
    if (!this.client || !discordJs?.SlashCommandBuilder) return;

    const { SlashCommandBuilder } = discordJs;
    const commands = [
      new SlashCommandBuilder()
        .setName('mode')
        .setDescription('查看或切换模式')
        .addStringOption((option: any) => option
          .setName('mode')
          .setDescription('plan | code | ask')
          .setRequired(false)
          .addChoices(
            { name: 'plan', value: 'plan' },
            { name: 'code', value: 'code' },
            { name: 'ask', value: 'ask' },
          ))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('model')
        .setDescription('查看或切换模型')
        .addStringOption((option: any) => option
          .setName('model')
          .setDescription('Model id (provider/model or id)')
          .setRequired(false))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('status')
        .setDescription('查看当前状态')
        .toJSON(),
    ];

    const appCommands = this.client.application?.commands;
    if (!appCommands) return;

    const existing = await appCommands.fetch();
    for (const commandData of commands) {
      const matched = existing.find((cmd: any) => cmd.name === commandData.name);
      if (matched) {
        await matched.edit(commandData);
      } else {
        await appCommands.create(commandData);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleChatInputInteraction(interaction: any): Promise<void> {
    const commandName = (interaction.commandName || '').toLowerCase();
    if (!['mode', 'model', 'status'].includes(commandName)) return;

    const chatId = interaction.channelId;
    const userId = interaction.user.id;
    const displayName = interaction.user.username;

    if (!this.isAuthorized(userId, chatId)) {
      try {
        if (discordJs?.MessageFlags?.Ephemeral !== undefined) {
          await interaction.reply({ content: 'Unauthorized', flags: discordJs.MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: 'Unauthorized', ephemeral: true });
        }
      } catch { /* best effort */ }
      return;
    }

    let text = `/${commandName}`;
    if (commandName === 'mode') {
      const modeArg = interaction.options?.getString?.('mode');
      if (modeArg) text = `${text} ${modeArg}`;
    } else if (commandName === 'model') {
      const modelArg = interaction.options?.getString?.('model');
      if (modelArg) text = `${text} ${modelArg}`;
    }

    try {
      if (discordJs?.MessageFlags?.Ephemeral !== undefined) {
        await interaction.reply({ content: `已提交命令：${text}`, flags: discordJs.MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: `已提交命令：${text}`, ephemeral: true });
      }
    } catch {
      return;
    }

    const isGuild = Boolean(interaction.guild);
    const isThread = Boolean(interaction.channel?.isThread?.());
    const parentChannelId = (interaction.channel?.parentId || interaction.channel?.parent?.id) as string | undefined;
    const scopeChain = isGuild
      ? [
        { kind: 'guild', id: interaction.guild.id as string },
        ...(isThread && parentChannelId ? [{ kind: 'channel', id: parentChannelId as string }] : []),
        { kind: isThread ? 'thread' : 'channel', id: chatId as string },
      ]
      : [{ kind: 'chat', id: chatId as string }];

    const inbound: InboundMessage = {
      messageId: `discord-cmd-${interaction.id}`,
      address: {
        channelType: 'discord',
        chatId,
        userId,
        displayName,
        channelName: (interaction.channel as { name?: string } | null | undefined)?.name ?? null,
        parentName: (interaction.channel?.parent as { name?: string } | null | undefined)?.name ?? null,
        guildName: interaction.guild?.name ?? null,
        isThread,
        scopeChain,
      },
      text,
      timestamp: Date.now(),
    };

    this.enqueue(inbound);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleInteraction(interaction: any): Promise<void> {
    if (interaction.isChatInputCommand?.()) {
      await this.handleChatInputInteraction(interaction);
      return;
    }

    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

    try {
      // Defer immediately to avoid 3s timeout
      await interaction.deferUpdate();
    } catch {
      // Interaction may already be handled
      return;
    }

    // Derive callbackData
    let callbackData: string;
    if (interaction.isStringSelectMenu()) {
      // Select Menu: combine customId + first selected value into cmd:action:value format
      const customId = interaction.customId; // e.g. "select:model"
      const selectedValue = interaction.values?.[0];
      if (!selectedValue) return;
      // Map "select:model" → "cmd:model"
      const action = customId.replace(/^select:/, '');
      callbackData = `cmd:${action}:${selectedValue}`;
    } else {
      callbackData = interaction.customId;
    }
    const chatId = interaction.channelId;
    const userId = interaction.user.id;
    const displayName = interaction.user.username;

    if (!this.isAuthorized(userId, chatId)) return;

    // Store interaction for answerCallback with TTL
    const interactionId = `discord-${interaction.id}`;
    this.pendingInteractions.set(interactionId, {
      interaction,
      expiresAt: Date.now() + INTERACTION_TTL_MS,
    });

    // Clean up expired interactions
    this.cleanupExpiredInteractions();

    const isGuild = Boolean(interaction.guild);
    const isThread = Boolean(interaction.channel?.isThread?.());
    const parentChannelId = (interaction.channel?.parentId || interaction.channel?.parent?.id) as string | undefined;
    const scopeChain = isGuild
      ? [
        { kind: 'guild', id: interaction.guild.id as string },
        ...(isThread && parentChannelId ? [{ kind: 'channel', id: parentChannelId as string }] : []),
        { kind: isThread ? 'thread' : 'channel', id: chatId as string },
      ]
      : [{ kind: 'chat', id: chatId as string }];

    const inbound: InboundMessage = {
      messageId: interactionId,
      address: {
        channelType: 'discord',
        chatId,
        userId,
        displayName,
        channelName: (interaction.channel as { name?: string } | null | undefined)?.name ?? null,
        parentName: (interaction.channel?.parent as { name?: string } | null | undefined)?.name ?? null,
        guildName: interaction.guild?.name ?? null,
        isThread,
        scopeChain,
      },
      text: '',
      timestamp: Date.now(),
      callbackData,
      callbackMessageId: interaction.message?.id,
    };

    this.enqueue(inbound);
  }

  // ── Utilities ───────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.add(messageId);

    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const id of this.seenMessageIds) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(id);
        removed++;
      }
    }
  }

  private cleanupExpiredInteractions(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingInteractions) {
      if (entry.expiresAt < now) {
        this.pendingInteractions.delete(id);
      }
    }
  }

  /**
   * Convert simple HTML tags to Discord markdown.
   * Handles the common tags used in bridge-manager command responses.
   */
  private htmlToDiscordMarkdown(html: string): string {
    return html
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<i>(.*?)<\/i>/gi, '*$1*')
      .replace(/<em>(.*?)<\/em>/gi, '*$1*')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''); // Strip remaining HTML tags
  }
}

// Self-register so bridge-manager can create DiscordAdapter via the registry.
registerAdapterFactory('discord', () => new DiscordAdapter());