/**
 * Conversation Engine — processes inbound IM messages through Claude.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import type { ChannelBinding } from './types.js';
import type {
  FileAttachment,
  SSEEvent,
  TokenUsage,
  MessageContentBlock,
} from './host.js';
import { getBridgeContext } from './context.js';
import { getDefaultModelForRuntime } from './bridge-manager.js';
import crypto from 'crypto';
import { formatScopeRuleTitle, resolveScope } from './scope-utils.js';

const UPLOAD_DIRECTORY_NAME = '.uploads';
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

function isImageAttachment(file: Pick<FileAttachment, 'type'>): boolean {
  return IMAGE_MIME_TYPES.has(file.type);
}

function sanitizeAttachmentFilename(name: string): string {
  const baseName = path.basename((name || '').trim()) || 'attachment';
  const sanitized = baseName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '');

  return sanitized || 'attachment';
}

type PersistedAttachmentMeta = {
  id: string;
  name: string;
  type: string;
  size: number;
  filePath: string;
};

function buildAttachmentPromptFromMeta(files: PersistedAttachmentMeta[]): string {
  if (files.length === 0) return '';

  return [
    '用户上传了以下附件，文件已经保存到当前工作目录。',
    '请先使用读文件工具按路径读取这些文件，再基于文件内容继续处理。',
    ...files.map((file) => `- ${file.name}: ${file.filePath}`),
  ].join('\n');
}

function persistNonImageAttachments(
  workDir: string,
  sessionId: string,
  files: FileAttachment[],
): PersistedAttachmentMeta[] {
  const uploadDir = path.join(path.resolve(workDir), UPLOAD_DIRECTORY_NAME, sessionId);
  fs.mkdirSync(uploadDir, { recursive: true });

  return files.map((file, index) => {
    const safeName = sanitizeAttachmentFilename(file.name);
    const uniquePrefix = `${Date.now()}-${index + 1}-${crypto.randomUUID().slice(0, 8)}`;
    const filePath = path.resolve(uploadDir, `${uniquePrefix}-${safeName}`);

    if (filePath !== uploadDir && !filePath.startsWith(`${uploadDir}${path.sep}`)) {
      throw new Error(`Resolved upload path escaped upload directory: ${filePath}`);
    }

    const buffer = Buffer.from(file.data, 'base64');
    fs.writeFileSync(filePath, buffer);

    return {
      id: file.id,
      name: file.name,
      type: file.type,
      size: buffer.length,
      filePath,
    };
  });
}

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

/**
 * Callback invoked when tool_use or tool_result SSE events arrive.
 * Used by bridge-manager to forward tool progress to adapters for real-time display.
 */
export type OnToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => void;

export interface ConversationResult {
  responseText: string;
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** SDK session ID captured from status/result events, for session resume */
  sdkSessionId: string | null;
}

/**
 * Process an inbound message: send to Claude, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
): Promise<ConversationResult> {
  const { store, llm } = getBridgeContext();
  const sessionId = binding.codepilotSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = store.acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      sdkSessionId: null,
    };
  }

  store.setSessionRuntimeStatus(sessionId, 'running');

  // Lock renewal interval
  const renewalInterval = setInterval(() => {
    try { store.renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    // Resolve session early — needed for workingDirectory and provider resolution
    const session = store.getSession(sessionId);

    // Save user message — persist file attachments to disk using the same
    // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
    let savedContent = text;
    let runtimeFiles = files;
    let attachmentPrompt = '';
    if (files && files.length > 0) {
      const nonImageFiles = files.filter((file) => !isImageAttachment(file));
      const workDir = binding.workingDirectory || session?.working_directory || '';
      if (workDir && nonImageFiles.length > 0) {
        try {
          const fileMeta = persistNonImageAttachments(workDir, sessionId, nonImageFiles);
          runtimeFiles = files.map((file) => {
            const persisted = fileMeta.find((meta) => meta.id === file.id);
            return persisted ? { ...file, filePath: persisted.filePath, size: persisted.size } : file;
          });
          attachmentPrompt = buildAttachmentPromptFromMeta(fileMeta);
          if (fileMeta.length > 0) {
            savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${text}`;
          }
        } catch (err) {
          console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} attachment(s) attached] ${text}`.trim();
        }
      } else if (!workDir && nonImageFiles.length > 0) {
        savedContent = `[${nonImageFiles.length} attachment(s) attached] ${text}`.trim();
      } else if (text.trim().length === 0) {
        const imageCount = files.filter((file) => isImageAttachment(file)).length;
        savedContent = `[${imageCount} image(s) attached]`;
      }
    }
    store.addMessage(sessionId, 'user', savedContent);

    const effectivePromptText = attachmentPrompt
      ? [text, attachmentPrompt].filter((part) => part && part.trim()).join('\n\n')
      : text;

    // Resolve provider
    let resolvedProvider: import('./host.js').BridgeApiProvider | undefined;
    const providerId = session?.provider_id || '';
    if (providerId && providerId !== 'env') {
      resolvedProvider = store.getProvider(providerId);
    }
    if (!resolvedProvider) {
      const defaultId = store.getDefaultProviderId();
      if (defaultId) resolvedProvider = store.getProvider(defaultId);
    }

    // Effective model
    const effectiveModel = binding.model || session?.model || store.getSetting('default_model') || getDefaultModelForRuntime(getBridgeContext().runtime);

    // Permission mode from binding mode
    let permissionMode: string;
    switch (binding.mode) {
      case 'plan': permissionMode = 'plan'; break;
      case 'ask': permissionMode = 'default'; break;
      default: permissionMode = 'acceptEdits'; break;
    }

    // Load conversation history for context
    const { messages: recentMsgs } = store.getMessages(sessionId, { limit: 50 });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const resolvedScope = resolveScope(
      binding.channelType,
      binding.chatId,
      binding.scopeKey,
      binding.scopeChain,
    );

    const layeredRules = resolvedScope.inheritedScopeKeys
      .map((scopeKey) => {
        const scoped = store.getScopedSystemPrompt(scopeKey);
        if (!scoped || !scoped.prompt.trim()) {
          return null;
        }
        return { scopeKey, prompt: scoped.prompt.trim() };
      })
      .filter((item): item is { scopeKey: string; prompt: string } => Boolean(item));

    const basePrompt = session?.system_prompt?.trim() || '';
    let effectiveSystemPrompt = basePrompt;

    if (layeredRules.length > 0) {
      const sections = layeredRules.map((rule) => {
        const title = formatScopeRuleTitle(rule.scopeKey);
        return `【${title}】\n${rule.prompt}`;
      });

      const layeredSection = [
        '以下是当前消息命中的分层规则（从宽到窄排序，越靠后优先级越高）：',
        ...sections,
        '如果不同层级存在冲突，以更具体、位置更靠后的规则为准。',
      ].join('\n\n');

      effectiveSystemPrompt = basePrompt
        ? `${basePrompt}\n\n${layeredSection}`
        : layeredSection;
    }
    const stream = llm.streamChat({
      prompt: effectivePromptText,
      sessionId,
      sdkSessionId: binding.sdkSessionId || undefined,
      model: effectiveModel,
      systemPrompt: effectiveSystemPrompt || undefined,
      workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
      abortController,
      permissionMode,
      provider: resolvedProvider,
      conversationHistory: historyMsgs,
      files: runtimeFiles,
      onRuntimeStatusChange: (status: string) => {
        try { store.setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
      },
    });

    // Consume the stream server-side (replicate collectStreamResponse pattern).
    // Permission requests are forwarded immediately via the callback during streaming
    // because the stream blocks until permission is resolved — we can't wait until after.
    return await consumeStream(stream, sessionId, onPermissionRequest, onPartialText, onToolEvent);
  } finally {
    clearInterval(renewalInterval);
    store.releaseSessionLock(sessionId, lockId);
    store.setSessionRuntimeStatus(sessionId, 'idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
): Promise<ConversationResult> {
  const { store } = getBridgeContext();
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedSdkSessionId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (event.type) {
          case 'text':
            currentText += event.data;
            if (onPartialText) {
              previewText += event.data;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            break;

          case 'tool_use': {
            if (currentText.trim()) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            try {
              contentBlocks.push({
                type: 'tool_use',
                id: event.id as string,
                name: event.name as string,
                input: event.input,
              });
              if (onToolEvent) {
                try { onToolEvent(event.id as string, event.name as string, 'running'); } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'tool_result': {
            try {
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: event.tool_use_id as string,
                content: event.content as string,
                is_error: (event.is_error as boolean) || false,
              };
              if (seenToolResultIds.has(newBlock.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === newBlock.tool_use_id
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(newBlock.tool_use_id);
                contentBlocks.push(newBlock);
              }
              if (onToolEvent) {
                try {
                  onToolEvent(
                    newBlock.tool_use_id,
                    '', // name not available in tool_result, adapter tracks by id
                    newBlock.is_error ? 'error' : 'complete',
                  );
                } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'permission_request': {
            try {
              const perm: PermissionRequestInfo = {
                permissionRequestId: event.permissionRequestId as string,
                toolName: event.toolName as string,
                toolInput: event.toolInput as Record<string, unknown>,
                suggestions: event.suggestions as unknown[],
              };
              permissionRequests.push(perm);
              // Forward immediately — the stream blocks until the permission is
              // resolved, so we must send the IM prompt *now*, not after the stream ends.
              if (onPermissionRequest) {
                onPermissionRequest(perm).catch((err) => {
                  console.error('[conversation-engine] Failed to forward permission request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'status': {
            try {
              if (event.session_id) {
                capturedSdkSessionId = event.session_id as string;
                store.updateSdkSessionId(sessionId, event.session_id as string);
              }
              if (event.model) {
                store.updateSessionModel(sessionId, event.model as string);
              }
            } catch { /* skip */ }
            break;
          }

          case 'task_update': {
            try {
              if (event.session_id && event.todos) {
                store.syncSdkTasks(event.session_id as string, event.todos as unknown[]);
              }
            } catch { /* skip */ }
            break;
          }

          case 'error':
            hasError = true;
            errorMessage = (event.data as string) || 'Unknown error';
            break;

          case 'result': {
            try {
              if (event.usage) tokenUsage = event.usage as TokenUsage;
              if (event.is_error) hasError = true;
              if (event.session_id) {
                capturedSdkSessionId = event.session_id as string;
                store.updateSdkSessionId(sessionId, event.session_id as string);
              }
            } catch { /* skip */ }
            break;
          }

          // tool_output, tool_timeout, mode_changed, done — ignored for bridge
        }
      }
    }

    // Flush remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    // Save assistant message
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content) {
        store.addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    // Extract text-only response for IM delivery
    const responseText = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return {
      responseText,
      tokenUsage,
      hasError,
      errorMessage,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  } catch (e) {
    // Best-effort save on stream error
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content) {
        store.addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    return {
      responseText: '',
      tokenUsage,
      hasError: true,
      errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  }
}