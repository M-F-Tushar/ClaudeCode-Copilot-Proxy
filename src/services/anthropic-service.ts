/**
 * Anthropic Service - translation layer between Claude Code and GitHub Copilot.
 *
 * Claude Code speaks the Anthropic Messages API. GitHub Copilot exposes the
 * same Claude models behind an OpenAI-style chat completions endpoint. This
 * module performs a full, lossless-as-possible translation in both directions,
 * including tool calling, images, and server-sent-event streaming - the three
 * features Claude Code depends on for day-to-day work.
 */

import { Response } from 'node-fetch';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { config } from '../config/index.js';
import { getCopilotToken } from './auth-service.js';
import {
  AnthropicError,
  AnthropicMessage,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicStopReason,
  AnthropicStreamEvent,
  AnthropicSystemPrompt,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicUsage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
} from '../types/anthropic.js';
import {
  CopilotChatMessage,
  CopilotChatRequest,
  CopilotChatResponse,
  CopilotChatStreamChunk,
  CopilotContentPart,
  CopilotTool,
  CopilotToolCall,
  CopilotToolChoice,
} from '../types/copilot-chat.js';
import { mapClaudeModelToCopilot } from '../utils/model-mapper.js';
import { buildCopilotHeaders } from '../utils/copilot-headers.js';
import { logger } from '../utils/logger.js';
import { upstreamFetch } from '../utils/upstream-fetch.js';
import { resolveRequestTokenBudget } from '../utils/token-budget.js';
import {
  estimateInputTokens,
  estimateInputTokensDetailed,
  estimateTokenUnits,
  recordInputTokenObservation,
} from '../utils/token-estimator.js';

export { estimateInputTokens };

const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_STREAM_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_BLOCKS = 1024;

/** OpenAI-style tool names accept `[a-zA-Z0-9_-]{1,64}`. */
const TOOL_NAME_PATTERN = /[^a-zA-Z0-9_-]/g;

/**
 * Error raised when GitHub Copilot rejects a request. Carries the upstream
 * status so the route layer can mirror it back to Claude Code instead of
 * flattening everything into a 500.
 */
export class CopilotApiError extends Error {
  readonly status: number;
  readonly errorType: AnthropicError['error']['type'];

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CopilotApiError';
    this.status = status;
    this.errorType = mapStatusToAnthropicErrorType(status);
  }
}

/**
 * Map an upstream HTTP status onto an Anthropic error type.
 */
export function mapStatusToAnthropicErrorType(
  status: number
): AnthropicError['error']['type'] {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 413:
      return 'invalid_request_error';
    case 429:
      return 'rate_limit_error';
    case 502:
    case 503:
    case 504:
      return 'overloaded_error';
    default:
      return 'api_error';
  }
}

// ============================================================================
// Request translation: Anthropic -> Copilot
// ============================================================================

/**
 * Flatten an Anthropic system prompt (string or array of text blocks) into a
 * single string. Claude Code always sends the array form.
 */
export function normalizeSystemPrompt(system?: AnthropicSystemPrompt): string {
  if (!system) {
    return '';
  }

  if (typeof system === 'string') {
    return system;
  }

  if (!Array.isArray(system)) {
    return '';
  }

  return system
    .filter((block): block is TextBlock => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

/**
 * Extract the plain text of Anthropic message content, ignoring non-text blocks.
 */
export function extractTextContent(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((block): block is TextBlock => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Convert an Anthropic image block into an OpenAI-style image part.
 * Returns null when the block carries no usable payload.
 */
function convertImageBlock(block: Extract<ContentBlock, { type: 'image' }>): CopilotContentPart | null {
  const source = block.source;
  if (!source) {
    return null;
  }

  if (source.type === 'url' && source.url) {
    return { type: 'image_url', image_url: { url: source.url } };
  }

  if (source.type === 'base64' && source.data) {
    const mediaType = source.media_type || 'image/png';
    return {
      type: 'image_url',
      image_url: { url: `data:${mediaType};base64,${source.data}` },
    };
  }

  return null;
}

/**
 * Flatten `tool_result` content (string or nested blocks) into text that the
 * Copilot API accepts on a `tool` role message.
 */
export function flattenToolResultContent(content: string | ContentBlock[] | undefined): string {
  if (content === undefined || content === null) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return String(content);
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      // `tool` role messages are text-only upstream.
      parts.push('[image omitted]');
    }
  }

  return parts.join('\n');
}

/**
 * Sanitize a tool name so it satisfies the upstream tool-name constraints.
 */
export function sanitizeToolName(name: string): string {
  // Reserve a namespace so a valid name cannot alias an encoded invalid name.
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name) && !name.startsWith('__cc_')) {
    return name;
  }
  const sanitized = name.replace(TOOL_NAME_PATTERN, '_');
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 24);
  return `__cc_${sanitized.slice(0, 34)}_${digest}`;
}

/**
 * Build the sanitized-name -> original-name lookup used to restore Claude
 * Code's tool names on the way back.
 */
export function buildToolNameMap(
  tools?: AnthropicTool[],
  messages?: AnthropicMessage[],
  toolChoice?: AnthropicToolChoice
): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools ?? []) {
    if (!tool?.name) {
      continue;
    }
    map.set(sanitizeToolName(tool.name), tool.name);
  }
  for (const message of messages ?? []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') {
        map.set(sanitizeToolName(block.name), block.name);
      }
    }
  }
  if (toolChoice?.type === 'tool') {
    map.set(sanitizeToolName(toolChoice.name), toolChoice.name);
  }
  return map;
}

/**
 * Convert Anthropic tool definitions into Copilot/OpenAI function tools.
 */
export function convertAnthropicToolsToCopilot(tools?: AnthropicTool[]): CopilotTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const converted = tools
    .filter((tool) => Boolean(tool?.name))
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: sanitizeToolName(tool.name),
        description: tool.description,
        parameters: (tool.input_schema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {},
        },
      },
    }));

  return converted.length > 0 ? converted : undefined;
}

/**
 * Convert Anthropic `tool_choice` into the Copilot/OpenAI equivalent.
 */
export function convertAnthropicToolChoiceToCopilot(
  toolChoice?: AnthropicToolChoice
): CopilotToolChoice | undefined {
  if (!toolChoice) {
    return undefined;
  }

  switch (toolChoice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: sanitizeToolName(toolChoice.name) } };
    default:
      return undefined;
  }
}

/**
 * Convert Anthropic messages (plus an optional system prompt) into the
 * Copilot chat message list.
 *
 * Anthropic packs tool results into the *next user* message as
 * `tool_result` blocks; OpenAI expects them as standalone `tool` role
 * messages placed directly after the assistant turn that requested them. This
 * function performs that re-ordering.
 */
export function convertAnthropicMessagesToCopilot(
  messages: AnthropicMessage[],
  system?: AnthropicSystemPrompt
): CopilotChatMessage[] {
  const result: CopilotChatMessage[] = [];

  const systemPrompt = normalizeSystemPrompt(system);
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const message of messages ?? []) {
    if (!message || !message.role) {
      continue;
    }

    if (typeof message.content === 'string') {
      // An empty assistant or system turn would be rejected upstream; skip it.
      if (message.content.length === 0 && message.role !== 'user') {
        continue;
      }
      result.push({ role: message.role, content: message.content });
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [];

    if (message.role === 'system') {
      // Mid-conversation system turns carry plain instructions; flatten their
      // text blocks so they are not misfiled as a user turn below.
      const text = blocks
        .filter((block): block is TextBlock => block?.type === 'text')
        .map((block) => block.text)
        .join('\n');

      if (text.length > 0) {
        result.push({ role: 'system', content: text });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: CopilotToolCall[] = [];

      for (const block of blocks) {
        if (!block || typeof block !== 'object') {
          continue;
        }
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: sanitizeToolName(block.name),
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
        // `thinking` blocks are intentionally dropped: Copilot has no
        // equivalent field and echoing them back confuses the model.
      }

      if (textParts.length === 0 && toolCalls.length === 0) {
        continue;
      }

      const assistantMessage: CopilotChatMessage = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null,
      };
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      result.push(assistantMessage);
      continue;
    }

    // User turn: emit tool results first, then the remaining content.
    const userParts: CopilotContentPart[] = [];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') {
        continue;
      }

      if (block.type === 'tool_result') {
        const text = flattenToolResultContent(block.content);
        result.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.is_error && text ? `Error: ${text}` : text || '(no output)',
        });
      } else if (block.type === 'text') {
        userParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const imagePart = convertImageBlock(block);
        if (imagePart) {
          userParts.push(imagePart);
        }
      }
    }

    if (userParts.length === 0) {
      continue;
    }

    const isTextOnly = userParts.every((part) => part.type === 'text');
    result.push({
      role: 'user',
      content: isTextOnly
        ? userParts.map((part) => (part as { text: string }).text).join('\n')
        : userParts,
    });
  }

  return result;
}

/**
 * True when any message carries an image, which requires the Copilot vision
 * request header.
 */
export function requestHasImages(messages: AnthropicMessage[]): boolean {
  return (messages ?? []).some(
    (message) =>
      Array.isArray(message?.content) &&
      message.content.some((block) => block?.type === 'image')
  );
}

/**
 * Build the full Copilot chat request body for an Anthropic message request.
 */
export function buildCopilotChatRequest(
  request: AnthropicMessageRequest,
  options: { stream: boolean }
): CopilotChatRequest {
  const budget = resolveRequestTokenBudget(request);

  const body: CopilotChatRequest = {
    model: budget.model,
    messages: convertAnthropicMessagesToCopilot(request.messages, request.system),
    stream: options.stream,
  };

  if (typeof request.max_tokens === 'number' && request.max_tokens > 0) {
    body.max_tokens = budget.effectiveMaxTokens;
  }

  if (typeof request.temperature === 'number') {
    body.temperature = request.temperature;
  }

  if (typeof request.top_p === 'number') {
    body.top_p = request.top_p;
  }

  if (Array.isArray(request.stop_sequences) && request.stop_sequences.length > 0) {
    body.stop = request.stop_sequences;
  }

  const tools = convertAnthropicToolsToCopilot(request.tools);
  if (tools) {
    body.tools = tools;
    const toolChoice = convertAnthropicToolChoiceToCopilot(request.tool_choice);
    if (toolChoice) {
      body.tool_choice = toolChoice;
    }
    if (request.tool_choice && 'disable_parallel_tool_use' in request.tool_choice &&
        typeof request.tool_choice.disable_parallel_tool_use === 'boolean') {
      body.parallel_tool_calls = !request.tool_choice.disable_parallel_tool_use;
    }
  }

  return body;
}

/**
 * Build the headers required by GitHub Copilot's chat endpoint.
 */
export { buildCopilotHeaders };

// ============================================================================
// Response translation: Copilot -> Anthropic
// ============================================================================

/**
 * Map an OpenAI finish reason onto an Anthropic stop reason.
 */
export function mapFinishReasonToStopReason(
  finishReason: string | null | undefined,
  hasToolUse: boolean
): AnthropicStopReason {
  if (hasToolUse) {
    return 'tool_use';
  }

  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    case 'stop':
    default:
      return 'end_turn';
  }
}

/**
 * Reject incomplete or non-object arguments rather than inventing executable input.
 */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Do not include generated arguments in errors or logs.
  }
  throw new CopilotApiError(502, 'Copilot returned invalid or incomplete tool arguments');
}

/**
 * Truncate text at the earliest stop sequence.
 *
 * Copilot accepts `stop` but does not act on it, so the Anthropic contract
 * (text cut before the sequence, `stop_reason: 'stop_sequence'`) is enforced
 * here instead.
 */
export function applyStopSequences(
  text: string,
  stopSequences?: string[]
): { text: string; matched: string | null } {
  if (!stopSequences?.length || !text) {
    return { text, matched: null };
  }

  let bestIndex = -1;
  let matched: string | null = null;

  for (const sequence of stopSequences) {
    if (!sequence) {
      continue;
    }
    const index = text.indexOf(sequence);
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
      matched = sequence;
    }
  }

  if (bestIndex === -1) {
    return { text, matched: null };
  }

  return { text: text.slice(0, bestIndex), matched };
}

/**
 * Length of the trailing run that could still grow into a stop sequence.
 *
 * Streaming must hold this many characters back, otherwise a sequence split
 * across two chunks would be emitted before it can be detected.
 */
export function pendingStopSequenceLength(text: string, stopSequences?: string[]): number {
  if (!stopSequences?.length || !text) {
    return 0;
  }

  let longest = 0;

  for (const sequence of stopSequences) {
    if (!sequence) {
      continue;
    }
    const max = Math.min(sequence.length - 1, text.length);
    for (let size = max; size > longest; size--) {
      if (text.endsWith(sequence.slice(0, size))) {
        longest = size;
        break;
      }
    }
  }

  return longest;
}

/**
 * Convert a Copilot completion, using the mapped request model only as fallback.
 */
export function convertCopilotToAnthropicResponse(
  data: CopilotChatResponse,
  model: string,
  toolNameMap: Map<string, string> = new Map(),
  stopSequences?: string[]
): AnthropicMessageResponse {
  // Copilot's Anthropic models split a single reply across several `choices`
  // entries: the text lands in one and the tool_calls in another. Reading only
  // choices[0] silently drops every tool call, which stalls Claude Code's
  // agent loop, so all choices are merged into one Anthropic message.
  const choices = data?.choices ?? [];

  const content: ContentBlock[] = [];
  const seenToolIds = new Set<string>();
  let stopSequenceHit: string | null = null;

  for (const entry of choices) {
    const raw = typeof entry?.message?.content === 'string' ? entry.message.content : '';
    if (!raw) {
      continue;
    }
    if (stopSequenceHit) {
      break;
    }
    const { text, matched } = applyStopSequences(raw, stopSequences);
    if (text) {
      content.push({ type: 'text', text });
    }
    if (matched) {
      stopSequenceHit = matched;
    }
  }

  for (const entry of choices) {
    for (const toolCall of entry?.message?.tool_calls ?? []) {
      if (typeof toolCall?.id !== 'string' || !toolCall.id || toolCall.id.length > 512 ||
          typeof toolCall?.function?.name !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(toolCall.function.name)) {
        throw new CopilotApiError(502, 'Copilot returned an incomplete tool call');
      }
      const id = toolCall.id;
      if (seenToolIds.has(id)) {
        continue;
      }
      seenToolIds.add(id);
      const block: ToolUseBlock = {
        type: 'tool_use',
        id,
        name: toolNameMap.get(toolCall.function.name) ?? toolCall.function.name,
        input: parseToolArguments(toolCall.function.arguments),
      };
      content.push(block);
    }
  }

  const choice = choices.find((entry) => entry?.finish_reason) ?? choices[0];

  // Anthropic clients expect at least one content block.
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const hasToolUse = content.some((block) => block.type === 'tool_use');

  const usage: AnthropicUsage = {
    input_tokens: data?.usage?.prompt_tokens ?? 0,
    output_tokens: data?.usage?.completion_tokens ?? 0,
  };

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: data.model || model,
    stop_reason: stopSequenceHit
      ? 'stop_sequence'
      : mapFinishReasonToStopReason(choice?.finish_reason, hasToolUse),
    stop_sequence: stopSequenceHit,
    usage,
  };
}

// ============================================================================
// Upstream requests
// ============================================================================

/**
 * Resolve the chat endpoint for the signed-in account.
 *
 * Individual, business and enterprise plans are served from different hosts
 * (e.g. `api.individual.githubcopilot.com`), advertised by the token response.
 */
export function resolveCopilotChatEndpoint(): string {
  if (config.copilot.chatEndpointOverride) {
    return config.copilot.chatEndpointOverride;
  }

  const api = getCopilotToken()?.endpoints?.api;
  if (api) {
    return `${api.replace(/\/+$/, '')}/chat/completions`;
  }

  return config.github.copilot.anthropicEndpoints.COPILOT_ANTHROPIC_CHAT;
}

/**
 * Send a request to GitHub Copilot's chat endpoint.
 *
 * @throws {CopilotApiError} When Copilot responds with a non-2xx status.
 */
async function postToCopilot(
  request: AnthropicMessageRequest,
  copilotToken: string,
  stream: boolean,
  signal?: AbortSignal
): Promise<Response> {
  const body = buildCopilotChatRequest(request, { stream });
  const headers = buildCopilotHeaders(copilotToken, {
    stream,
    hasImages: requestHasImages(request.messages),
  });

  logger.debug('Requesting Copilot chat completion', {
    model: body.model,
    requestedModel: request.model,
    messages: body.messages.length,
    tools: body.tools?.length ?? 0,
    stream,
  });

  const response = await upstreamFetch(resolveCopilotChatEndpoint(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    destroyBody(response.body);
    logger.error('Copilot chat API error', {
      status: response.status,
    });
    throw new CopilotApiError(
      response.status,
      `Copilot API request failed with status ${response.status}`
    );
  }

  return response;
}

function destroyBody(body: NodeJS.ReadableStream | null): void {
  (body as (NodeJS.ReadableStream & { destroy?: () => void }) | null)?.destroy?.();
}

/**
 * Perform a non-streaming completion and return an Anthropic message.
 */
export async function makeAnthropicCompletionRequest(
  request: AnthropicMessageRequest,
  copilotToken: string,
  signal?: AbortSignal
): Promise<AnthropicMessageResponse> {
  const mappedModel = mapClaudeModelToCopilot(request.model);
  const estimate = estimateInputTokensDetailed(
    request.messages,
    request.system,
    request.tools,
    mappedModel
  );
  const response = await postToCopilot(request, copilotToken, false, signal);
  let data: CopilotChatResponse;
  try {
    data = (await response.json()) as CopilotChatResponse;
  } catch {
    throw new CopilotApiError(502, 'Copilot returned an invalid or incomplete response');
  } finally {
    destroyBody(response.body);
  }
  if (!data || data.error || !Array.isArray(data.choices)) {
    throw new CopilotApiError(502, 'Copilot returned an invalid completion');
  }
  const result = convertCopilotToAnthropicResponse(
    data,
    mappedModel,
    buildToolNameMap(request.tools, request.messages, request.tool_choice),
    request.stop_sequences
  );
  recordInputTokenObservation(mappedModel, estimate.rawInputTokens, result.usage.input_tokens);
  if (result.model !== mappedModel) {
    recordInputTokenObservation(result.model, estimate.rawInputTokens, result.usage.input_tokens);
  }
  return result;
}

/**
 * Parse a raw SSE body into Copilot stream chunks.
 */
export async function* parseCopilotSseStream(
  body: NodeJS.ReadableStream
): AsyncGenerator<CopilotChatStreamChunk> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let dataLines: string[] = [];
  let eventType = '';
  let eventBytes = 0;
  const decodedChunks = async function* () {
    for await (const chunk of body) {
      let text: string;
      try {
        text = decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, {
          stream: true,
        });
      } catch {
        throw new CopilotApiError(502, 'Copilot returned invalid UTF-8 in its stream');
      }
      yield { text, final: false };
    }
    let text: string;
    try {
      text = decoder.decode();
    } catch {
      throw new CopilotApiError(502, 'Copilot returned incomplete UTF-8 in its stream');
    }
    yield { text, final: true };
  };

  try {
    for await (const { text, final } of decodedChunks()) {
      buffer += text;
      let newline = /\r\n|\r|\n/.exec(buffer);
      while (newline) {
        // A CR at a network boundary may be the first half of CRLF.
        if (!final && newline[0] === '\r' && newline.index === buffer.length - 1) {
          break;
        }
        const line = buffer.slice(0, newline.index);
        buffer = buffer.slice(newline.index + newline[0].length);
        eventBytes += Buffer.byteLength(line) + newline[0].length;
        if (eventBytes > MAX_SSE_EVENT_BYTES) {
          throw new CopilotApiError(502, 'Copilot stream event exceeded the buffer limit');
        }
        if (line === '') {
          const data = dataLines.join('\n');
          if (eventType === 'error') {
            throw new CopilotApiError(502, 'Copilot reported a streaming error');
          }
          dataLines = [];
          eventType = '';
          eventBytes = 0;
          if (data.trim() === '[DONE]') {
            return;
          }
          if (data) {
            let parsed: CopilotChatStreamChunk;
            try {
              parsed = JSON.parse(data) as CopilotChatStreamChunk;
            } catch {
              throw new CopilotApiError(502, 'Copilot returned malformed stream data');
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.error) {
              throw new CopilotApiError(502, 'Copilot reported an invalid stream response');
            }
            yield parsed;
          }
        } else {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'data') {
            dataLines.push(value);
          } else if (field === 'event') {
            eventType = value;
          }
        }
        newline = /\r\n|\r|\n/.exec(buffer);
      }
      if (eventBytes + Buffer.byteLength(buffer) > MAX_SSE_EVENT_BYTES) {
        throw new CopilotApiError(502, 'Copilot stream event exceeded the buffer limit');
      }
    }
    throw new CopilotApiError(502, 'Copilot stream ended before its completion marker');
  } finally {
    destroyBody(body);
  }
}

// ============================================================================
// Anthropic streaming
// ============================================================================

interface StreamingToolCall {
  type: 'tool';
  choiceIndex: number;
  id: string;
  name: string;
  argumentsJson: string;
  complete: boolean;
  bytes: number;
}

interface StreamingText {
  type: 'text';
  text: string;
}

/**
 * Run a streaming completion and yield Anthropic SSE events.
 *
 * When `config.anthropic.streamUpstream` is disabled, a buffered response is
 * replayed as the same valid event sequence.
 */
export async function* streamAnthropicMessage(
  request: AnthropicMessageRequest,
  copilotToken: string,
  signal?: AbortSignal
): AsyncGenerator<AnthropicStreamEvent> {
  const messageId = generateMessageId();
  const mappedModel = mapClaudeModelToCopilot(request.model);
  const estimate = estimateInputTokensDetailed(
    request.messages,
    request.system,
    request.tools,
    mappedModel
  );
  const toolNameMap = buildToolNameMap(request.tools, request.messages, request.tool_choice);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) {
    controller.abort();
  }
  let response: Response | undefined;

  try {
    if (!config.anthropic.streamUpstream) {
      const completion = await makeAnthropicCompletionRequest(request, copilotToken, controller.signal);
      yield* replayResponseAsEvents(messageId, completion.model, completion);
      return;
    }
    response = await postToCopilot(request, copilotToken, true, controller.signal);
    if (!response.body) {
      throw new CopilotApiError(502, 'Copilot returned an empty streaming response');
    }
    yield* convertCopilotStreamToAnthropicEvents(
      parseCopilotSseStream(response.body),
      {
        messageId,
        model: mappedModel,
        toolNameMap,
        estimatedInputTokens: estimate.inputTokens,
        stopSequences: request.stop_sequences,
        onInputTokens: (actualModel, actualInputTokens) => {
          recordInputTokenObservation(
            mappedModel,
            estimate.rawInputTokens,
            actualInputTokens
          );
          if (actualModel !== mappedModel) {
            recordInputTokenObservation(
              actualModel,
              estimate.rawInputTokens,
              actualInputTokens
            );
          }
        },
      }
    );
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', onAbort);
    destroyBody(response?.body ?? null);
  }
}

/**
 * Convert a stream of Copilot chat chunks into a well-formed Anthropic SSE
 * event sequence.
 *
 * Text streams immediately unless an earlier, unfinished tool blocks it.
 * Parallel tools are buffered until their choice finishes, validated, and
 * replayed in first-seen order so Anthropic blocks never overlap.
 */
export async function* convertCopilotStreamToAnthropicEvents(
  chunks: AsyncIterable<CopilotChatStreamChunk>,
  options: {
    messageId: string;
    model: string;
    toolNameMap?: Map<string, string>;
    estimatedInputTokens?: number;
    stopSequences?: string[];
    onInputTokens?: (model: string, inputTokens: number) => void;
  }
): AsyncGenerator<AnthropicStreamEvent> {
  const { messageId } = options;
  let model = options.model;
  const toolNameMap = options.toolNameMap ?? new Map<string, string>();
  const stopSequences = options.stopSequences;

  let inputTokens = options.estimatedInputTokens ?? 0;
  let authoritativeInputTokens: number | undefined;
  let authoritativeOutputTokens: number | undefined;
  let estimatedOutputUnits = 0;
  let startedMessage = false;
  let textBlockIndex: number | null = null;
  let nextBlockIndex = 0;
  let finishReason: string | null = null;
  let sawFinish = false;
  // Text received but withheld because it may still complete a stop sequence.
  let pendingText = '';
  let stopSequenceHit: string | null = null;
  const toolCalls = new Map<string, StreamingToolCall>();
  const contentChoices = new Set<number>();
  const finishedChoices = new Set<number>();
  const toolIds = new Set<string>();
  const queue: (StreamingToolCall | StreamingText)[] = [];
  let bufferedBytes = 0;
  let registeredBlocks = 0;

  const checkBuffer = () => {
    if (bufferedBytes + Buffer.byteLength(pendingText) > MAX_STREAM_BUFFER_BYTES ||
        registeredBlocks > MAX_STREAM_BLOCKS || contentChoices.size > MAX_STREAM_BLOCKS) {
      throw new CopilotApiError(502, 'Copilot stream exceeded the buffer limit');
    }
  };

  const enqueueText = (text: string) => {
    if (!text) {
      return;
    }
    const tail = queue[queue.length - 1];
    if (tail?.type === 'text') {
      tail.text += text;
    } else {
      queue.push({ type: 'text', text });
      // Consecutive immediate text deltas share the currently open block.
      if (textBlockIndex === null || queue.length > 1) {
        registeredBlocks++;
      }
    }
    bufferedBytes += Buffer.byteLength(text);
    checkBuffer();
  };

  const emitMessageStart = function* (): Generator<AnthropicStreamEvent> {
    if (startedMessage) {
      return;
    }
    startedMessage = true;
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    };
  };

  const drain = function* (): Generator<AnthropicStreamEvent> {
    while (queue.length > 0) {
      const next = queue[0];
      yield* emitMessageStart();
      if (next.type === 'text') {
        if (textBlockIndex === null) {
          textBlockIndex = nextBlockIndex++;
          yield {
            type: 'content_block_start',
            index: textBlockIndex,
            content_block: { type: 'text', text: '' },
          };
        }
        yield {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: next.text },
        };
        bufferedBytes -= Buffer.byteLength(next.text);
        queue.shift();
        continue;
      }
      if (textBlockIndex !== null) {
        yield { type: 'content_block_stop', index: textBlockIndex };
        textBlockIndex = null;
      }
      if (!next.complete) {
        return;
      }
      const index = nextBlockIndex++;
      yield {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: next.id,
          name: toolNameMap.get(next.name) ?? next.name,
          input: {},
        },
      };
      yield {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: next.argumentsJson },
      };
      yield { type: 'content_block_stop', index };
      bufferedBytes -= next.bytes;
      next.argumentsJson = '';
      next.bytes = 0;
      queue.shift();
    }
  };

  stream: for await (const chunk of chunks) {
    if (!chunk || chunk.error || (chunk.choices !== undefined && !Array.isArray(chunk.choices))) {
      throw new CopilotApiError(502, 'Copilot returned an invalid stream response');
    }
    if (chunk.model) {
      if (startedMessage && chunk.model !== model) {
        throw new CopilotApiError(502, 'Copilot changed model identity during its stream');
      }
      model = chunk.model;
    }
    if (chunk.usage) {
      if (typeof chunk.usage.prompt_tokens === 'number') {
        inputTokens = chunk.usage.prompt_tokens;
        authoritativeInputTokens = chunk.usage.prompt_tokens;
      }
      authoritativeOutputTokens = chunk.usage.completion_tokens ?? authoritativeOutputTokens;
    }
    for (const [position, choice] of (chunk.choices ?? []).entries()) {
      if (!choice || typeof choice !== 'object') {
        throw new CopilotApiError(502, 'Copilot returned an invalid stream choice');
      }
      const choiceIndex = choice.index ?? position;
      if (!Number.isInteger(choiceIndex) || choiceIndex < 0) {
        throw new CopilotApiError(502, 'Copilot returned an invalid choice index');
      }
      const delta = choice.delta;
      if (delta?.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
        throw new CopilotApiError(502, 'Copilot returned invalid tool fragments');
      }
      const hasContent = Boolean(delta?.content || delta?.tool_calls?.length);
      if (hasContent && finishedChoices.has(choiceIndex)) {
        throw new CopilotApiError(502, 'Copilot sent content after finishing a choice');
      }
      if (hasContent) {
        contentChoices.add(choiceIndex);
      }
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        estimatedOutputUnits += estimateTokenUnits(delta.content);
        pendingText += delta.content;
        checkBuffer();
        const { text, matched } = applyStopSequences(pendingText, stopSequences);
        const hold = matched ? 0 : pendingStopSequenceLength(text, stopSequences);
        pendingText = hold > 0 ? text.slice(-hold) : '';
        enqueueText(hold > 0 ? text.slice(0, -hold) : text);
        yield* drain();
        if (matched) {
          stopSequenceHit = matched;
          break stream;
        }
      }
      for (const toolDelta of delta?.tool_calls ?? []) {
        if (!toolDelta || !Number.isInteger(toolDelta.index) || toolDelta.index < 0) {
          throw new CopilotApiError(502, 'Copilot returned an invalid tool index');
        }
        const key = `${choiceIndex}:${toolDelta.index}`;
        let tracked = toolCalls.get(key);
        if (!tracked) {
          // A tool starts a new content block; preserve the preceding text tail.
          const tail = pendingText;
          pendingText = '';
          enqueueText(tail);
          tracked = {
            type: 'tool',
            choiceIndex,
            id: '',
            name: '',
            argumentsJson: '',
            complete: false,
            bytes: 0,
          };
          toolCalls.set(key, tracked);
          queue.push(tracked);
          registeredBlocks++;
        }
        const id = toolDelta.id ?? '';
        const name = toolDelta.function?.name ?? '';
        const argumentsJson = toolDelta.function?.arguments ?? '';
        if (typeof id !== 'string' || typeof name !== 'string' ||
            typeof argumentsJson !== 'string') {
          throw new CopilotApiError(502, 'Copilot returned malformed tool fragments');
        }
        if (tracked.id.length + id.length > 512 || tracked.name.length + name.length > 64) {
          throw new CopilotApiError(502, 'Copilot returned oversized tool metadata');
        }
        const addedBytes = Buffer.byteLength(id) + Buffer.byteLength(name) +
          Buffer.byteLength(argumentsJson);
        tracked.id += id;
        tracked.name += name;
        tracked.argumentsJson += argumentsJson;
        tracked.bytes += addedBytes;
        bufferedBytes += addedBytes;
        estimatedOutputUnits += estimateTokenUnits(argumentsJson);
        checkBuffer();
      }
      if (choice.finish_reason) {
        sawFinish = true;
        if (finishedChoices.size >= MAX_STREAM_BLOCKS && !finishedChoices.has(choiceIndex)) {
          throw new CopilotApiError(502, 'Copilot stream exceeded the choice limit');
        }
        finishedChoices.add(choiceIndex);
        if (!finishReason || choice.finish_reason !== 'stop') {
          finishReason = choice.finish_reason;
        }
        for (const tracked of toolCalls.values()) {
          if (tracked.choiceIndex !== choiceIndex || tracked.complete) {
            continue;
          }
          if (!tracked.id || !/^[a-zA-Z0-9_-]{1,64}$/.test(tracked.name) ||
              toolIds.has(tracked.id)) {
            throw new CopilotApiError(502, 'Copilot returned incomplete or duplicate tool metadata');
          }
          parseToolArguments(tracked.argumentsJson);
          toolIds.add(tracked.id);
          tracked.complete = true;
        }
      }
      yield* drain();
    }
  }

  if ((!stopSequenceHit && (!sawFinish ||
      [...contentChoices].some((index) => !finishedChoices.has(index)))) ||
      [...toolCalls.values()].some((tool) => !tool.complete)) {
    throw new CopilotApiError(502, 'Copilot stream ended with an incomplete choice or tool call');
  }
  const tail = pendingText;
  pendingText = '';
  enqueueText(tail);
  yield* drain();
  yield* emitMessageStart();

  if (textBlockIndex !== null) {
    yield { type: 'content_block_stop', index: textBlockIndex };
  } else if (nextBlockIndex === 0) {
    // The model produced nothing; still emit a well-formed empty text block.
    const emptyIndex = nextBlockIndex++;
    yield {
      type: 'content_block_start',
      index: emptyIndex,
      content_block: { type: 'text', text: '' },
    };
    yield { type: 'content_block_stop', index: emptyIndex };
  }

  if (authoritativeInputTokens !== undefined) {
    options.onInputTokens?.(model, authoritativeInputTokens);
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: stopSequenceHit
        ? 'stop_sequence'
        : mapFinishReasonToStopReason(finishReason, toolCalls.size > 0),
      stop_sequence: stopSequenceHit,
    },
    usage: {
      input_tokens: inputTokens,
      output_tokens: authoritativeOutputTokens ?? Math.ceil(estimatedOutputUnits / 12),
    },
  };

  yield { type: 'message_stop' };
}

/**
 * Emit a complete (non-streamed) Anthropic message as a valid event sequence.
 */
function* replayResponseAsEvents(
  messageId: string,
  model: string,
  response: AnthropicMessageResponse
): Generator<AnthropicStreamEvent> {
  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: response.usage.input_tokens, output_tokens: 0 },
    },
  };

  let index = 0;
  for (const block of response.content) {
    if (block.type === 'text') {
      yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
      if (block.text) {
        yield {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        };
      }
      yield { type: 'content_block_stop', index };
      index += 1;
    } else if (block.type === 'tool_use') {
      yield {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      };
      yield {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      };
      yield { type: 'content_block_stop', index };
      index += 1;
    }
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: response.stop_reason ?? 'end_turn',
      stop_sequence: response.stop_sequence,
    },
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };

  yield { type: 'message_stop' };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create an Anthropic-shaped error response body.
 */
export function createAnthropicError(
  type: AnthropicError['error']['type'],
  message: string
): AnthropicError {
  return {
    type: 'error',
    error: { type, message },
  };
}

/**
 * Generate a message ID in Anthropic's format.
 */
export function generateMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, '').substring(0, 24)}`;
}
