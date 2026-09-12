import { Response } from 'node-fetch';
import { config } from '../config/index.js';
import { AnthropicCountTokensRequest, AnthropicMessageRequest } from '../types/anthropic.js';
import { buildCopilotHeaders } from '../utils/copilot-headers.js';
import { RequestCompatibilityError } from '../utils/request-policy.js';
import { createSseRelay, SseRelayError } from '../utils/sse-relay.js';
import {
  destroyUpstreamBody,
  forwardableUpstreamHeaders,
  upstreamAbortReason,
  upstreamFetch,
} from '../utils/upstream-fetch.js';
import { getCopilotToken } from './auth-service.js';
import { CopilotApiError, mapStatusToAnthropicErrorType } from './anthropic-service.js';
import { findCatalogModel } from './model-catalog.js';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const TOKEN_FIELDS = [
  'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
] as const;

export interface NativeRequestHeaders {
  version?: string;
  beta?: string;
}

export function usesNativeAnthropic(model: string): boolean {
  if (config.anthropic.upstreamMode === 'chat') return false;
  const catalog = findCatalogModel(model);
  const supported = catalog?.isClaude === true &&
    catalog.supportedEndpoints?.includes('/v1/messages') === true;
  if (config.anthropic.upstreamMode === 'native') {
    if (!supported && !config.copilot.messagesEndpointOverride) {
      throw new RequestCompatibilityError(
        `Model '${model}' does not advertise the native Messages API. Select another model or explicitly use chat mode.`
      );
    }
    return true;
  }
  if (config.copilot.messagesEndpointOverride) return true;
  // A pinned chat endpoint must not silently route its traffic to another host.
  return !config.copilot.chatEndpointOverride && supported;
}

function resolveNativeEndpoint(countTokens: boolean): string {
  const configured = config.copilot.messagesEndpointOverride;
  const api = getCopilotToken()?.endpoints?.api;
  if (!configured && !api) {
    throw new RequestCompatibilityError('Native Messages requires an account API endpoint or COPILOT_MESSAGES_ENDPOINT');
  }
  const messages = configured ?? `${api!.replace(/\/+$/, '')}/v1/messages`;
  return `${messages.replace(/\/+$/, '')}${countTokens ? '/count_tokens' : ''}`;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasImages(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const next = pending.pop();
    if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (isJsonObject(next)) {
      if (next.type === 'image') return true;
      if (next.content !== undefined) pending.push(next.content);
    }
  }
  return false;
}

export async function postNativeAnthropic(
  request: AnthropicMessageRequest | AnthropicCountTokensRequest,
  model: string,
  token: string,
  headers: NativeRequestHeaders,
  signal: AbortSignal,
  countTokens = false
): Promise<Response> {
  const stream = !countTokens && 'stream' in request && request.stream === true;
  const upstreamHeaders = buildCopilotHeaders(token, {
    stream,
    hasImages: hasImages(request.messages),
  });
  upstreamHeaders['anthropic-version'] = headers.version ?? '2023-06-01';
  if (headers.beta) upstreamHeaders['anthropic-beta'] = headers.beta;
  return upstreamFetch(resolveNativeEndpoint(countTokens), {
    method: 'POST',
    headers: upstreamHeaders,
    // Keep native blocks, signatures, cache controls and future fields intact.
    body: JSON.stringify({ ...request, model }),
    signal,
    size: MAX_RESPONSE_BYTES,
  });
}

export const nativeResponseHeaders = forwardableUpstreamHeaders;

export async function readNativeJson(response: Response): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw upstreamAbortReason(response) ??
      new CopilotApiError(502, 'Copilot returned an invalid or incomplete native response');
  } finally {
    destroyUpstreamBody(response);
  }
  try {
    const value: unknown = JSON.parse(text);
    if (isJsonObject(value)) return value;
  } catch {
    // Handled below: Copilot sometimes answers 4xx with a plain-text body.
  }
  if (!response.ok) {
    // Preserve the upstream status; wrap the text so Claude Code still gets its envelope.
    return {
      type: 'error',
      error: {
        type: mapStatusToAnthropicErrorType(response.status),
        message: text.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 500) || `Copilot returned HTTP ${response.status}`,
      },
    };
  }
  throw new CopilotApiError(502, 'Copilot returned an invalid native response');
}

export function mergeNativeUsage(
  previous: Record<string, unknown>,
  value: unknown
): Record<string, unknown> {
  if (!isJsonObject(value)) {
    throw new CopilotApiError(502, 'Copilot returned invalid native usage');
  }
  for (const field of TOKEN_FIELDS) {
    if (field.startsWith('cache_') && value[field] === null) continue;
    if (value[field] !== undefined &&
        (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0)) {
      throw new CopilotApiError(502, 'Copilot returned invalid native token usage');
    }
  }
  return { ...previous, ...value };
}

export function nativeTokenTotal(usage: Record<string, unknown>): number {
  return TOKEN_FIELDS.reduce((total, field) => total + Number(usage[field] ?? 0), 0);
}

export interface NativeFrame {
  raw: string;
  event?: Record<string, unknown>;
}

/**
 * Observe native events for usage/lifecycle only. Forward their original frame
 * rather than rebuilding content, so thinking, signatures and future deltas
 * survive unchanged. Stop at message_stop and keep the connection reusable.
 */
export async function* nativeFrames(response: Response): AsyncGenerator<NativeFrame> {
  const relay = createSseRelay(response);
  try {
    for await (const frame of relay.frames()) {
      let event: Record<string, unknown> | undefined;
      if (frame.data) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.data);
        } catch {
          throw new CopilotApiError(502, 'Copilot returned malformed native stream data');
        }
        if (!isJsonObject(parsed) || typeof parsed.type !== 'string') {
          throw new CopilotApiError(502, 'Copilot returned an invalid native event');
        }
        event = parsed;
      }
      const terminal = event?.type === 'message_stop' || event?.type === 'error';
      if (terminal) {
        relay.complete();
      }
      yield { raw: frame.raw, event };
      if (terminal) {
        return;
      }
    }
  } catch (error) {
    if (error instanceof SseRelayError) {
      throw new CopilotApiError(502, `Copilot native stream ${error.message}`);
    }
    throw error;
  }
}
