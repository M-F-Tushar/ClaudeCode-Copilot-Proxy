/**
 * OpenAI-compatible routes for Cursor and other OpenAI-dialect clients.
 *
 * GitHub Copilot's chat endpoint already speaks the OpenAI chat-completions
 * dialect, so requests are forwarded with only model resolution and Copilot
 * identity headers changed. Responses and SSE frames are relayed unchanged.
 */

import express from 'express';
import { randomUUID } from 'node:crypto';
import { Response } from 'node-fetch';
import { AVAILABLE_CLAUDE_MODELS, config } from '../config/index.js';
import {
  ensureCopilotToken,
  getCopilotToken,
  isTokenValid,
} from '../services/auth-service.js';
import { resolveCopilotChatEndpoint } from '../services/anthropic-service.js';
import {
  findCatalogModel,
  getCatalogSnapshot,
  refreshModelCatalog,
} from '../services/model-catalog.js';
import { trackRequest, trackTokens } from '../services/usage-service.js';
import { OpenAICompletionRequest } from '../types/openai.js';
import { buildCopilotHeaders } from '../utils/copilot-headers.js';
import { logger } from '../utils/logger.js';
import { mapClaudeModelToCopilot } from '../utils/model-mapper.js';
import { abortOnDisconnect, writeResponse } from '../utils/response-stream.js';
import { createSseRelay, SseRelayError } from '../utils/sse-relay.js';
import {
  destroyUpstreamBody,
  forwardableUpstreamHeaders,
  upstreamAbortReason,
  upstreamFetch,
  UpstreamTimeoutError,
} from '../utils/upstream-fetch.js';

export const openaiRoutes = express.Router();

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface OpenAIErrorBody extends Record<string, unknown> {
  error: { message: string; type: string; code: number };
}

function openAiError(status: number, type: string, message: string): OpenAIErrorBody {
  return { error: { message, type, code: status } };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const requireAuth = async (
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  if (isTokenValid()) {
    return next();
  }
  try {
    await ensureCopilotToken();
    return next();
  } catch {
    logger.warn('Copilot authentication unavailable');
    return res.status(401).json(openAiError(
      401, 'authentication_error',
      'GitHub Copilot authentication required. Please authenticate at /auth.html'
    ));
  }
};

class UnsupportedEndpointError extends Error {
  readonly status = 400;

  constructor(model: string, endpoints: string[]) {
    super(
      `Model '${model}' is served only through ${endpoints.join(', ')}, which this ` +
      'OpenAI-compatible route does not relay. Choose a model listed by GET /openai/v1/models.'
    );
    this.name = 'UnsupportedEndpointError';
  }
}

/** Models Copilot serves through its OpenAI-style chat endpoint (unknown endpoint lists pass). */
function servesChatCompletions(model: { supportedEndpoints?: string[] }): boolean {
  const endpoints = model.supportedEndpoints ?? [];
  return endpoints.length === 0 || endpoints.includes('/chat/completions');
}

/**
 * Live catalog IDs are forwarded verbatim. Claude names receive the same
 * strict/compatible resolution as Claude Code traffic; other IDs pass through
 * so Copilot reports unsupported models itself.
 */
function resolveModel(model: unknown): string {
  const requested = typeof model === 'string' && model.trim() ? model.trim() : config.anthropic.defaultModel;
  const live = findCatalogModel(requested);
  const resolved = live
    ? live.id
    : /^(claude|opus|sonnet|haiku|opusplan)/i.test(requested)
      ? mapClaudeModelToCopilot(requested)
      : requested;
  const catalog = findCatalogModel(resolved);
  if (catalog && !servesChatCompletions(catalog)) {
    throw new UnsupportedEndpointError(resolved, catalog.supportedEndpoints ?? []);
  }
  return resolved;
}

function hasImageParts(messages: unknown): boolean {
  return Array.isArray(messages) && messages.some((message) =>
    isJsonObject(message) && Array.isArray(message.content) &&
    message.content.some((part) => isJsonObject(part) && part.type === 'image_url')
  );
}

function totalTokens(usage: unknown): number {
  if (!isJsonObject(usage)) {
    return 0;
  }
  const total = usage.total_tokens;
  if (Number.isSafeInteger(total) && Number(total) >= 0) {
    return Number(total);
  }
  const prompt = Number.isSafeInteger(usage.prompt_tokens) ? Number(usage.prompt_tokens) : 0;
  const completion = Number.isSafeInteger(usage.completion_tokens) ? Number(usage.completion_tokens) : 0;
  return Math.max(0, prompt + completion);
}

function toOpenAiErrorResponse(error: unknown): { status: number; body: OpenAIErrorBody } {
  if (error instanceof UnsupportedEndpointError ||
      (error instanceof Error && error.name === 'ModelSelectionError')) {
    return { status: 400, body: openAiError(400, 'invalid_request_error', error.message) };
  }
  if (error instanceof UpstreamTimeoutError) {
    return { status: 504, body: openAiError(504, 'timeout_error', error.message) };
  }
  if (error instanceof SseRelayError) {
    return { status: 502, body: openAiError(502, 'upstream_error', `Copilot stream ${error.message}`) };
  }
  return { status: 500, body: openAiError(500, 'api_error', 'Internal server error') };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw upstreamAbortReason(response) ?? new SseRelayError('returned an invalid or incomplete JSON body');
  } finally {
    destroyUpstreamBody(response);
  }
  try {
    const value: unknown = JSON.parse(text);
    if (isJsonObject(value)) {
      return value;
    }
  } catch {
    // Handled below: Copilot answers some 4xx with a plain-text body.
  }
  if (!response.ok) {
    const message = text.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 500);
    return openAiError(response.status, 'upstream_error', message || `Copilot returned HTTP ${response.status}`);
  }
  throw new SseRelayError('returned an invalid JSON body');
}

/**
 * OpenAI deprecated `max_tokens` in favour of `max_completion_tokens`, and
 * Copilot rejects the old field for GPT-5.x. Every chat-endpoint family
 * accepts the new one, so it is renamed when the modern field is absent.
 */
function modernizeRequest(request: OpenAICompletionRequest & Record<string, unknown>): {
  body: Record<string, unknown>; warnings: string[];
} {
  const body: Record<string, unknown> = { ...request };
  const warnings: string[] = [];
  if (body.max_tokens !== undefined && body.max_completion_tokens === undefined) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    warnings.push('max_tokens_renamed');
  }
  return { body, warnings };
}

// GET /v1/models - every chat-completions model the account can use, in OpenAI's envelope
openaiRoutes.get('/models', requireAuth, async (_req, res) => {
  await refreshModelCatalog();
  const snapshot = getCatalogSnapshot().filter(servesChatCompletions);
  const data = snapshot.length > 0
    ? snapshot.map((model) => ({
      id: model.id, object: 'model', created: 0, owned_by: model.vendor || 'github-copilot',
    }))
    : AVAILABLE_CLAUDE_MODELS.map((model) => ({
      id: model.id, object: 'model', created: 0, owned_by: 'github-copilot',
    }));
  res.json({ object: 'list', data });
});

// POST /v1/chat/completions - relayed to Copilot's OpenAI-compatible endpoint
openaiRoutes.post('/chat/completions', requireAuth, async (req, res) => {
  const sessionId: string = res.locals.sessionId || randomUUID();
  const request = req.body as OpenAICompletionRequest;
  if (!isJsonObject(request) || !Array.isArray(request.messages) || request.messages.length === 0) {
    return res.status(400).json(openAiError(400, 'invalid_request_error', 'messages: field required'));
  }
  const copilotToken = getCopilotToken();
  if (!copilotToken) {
    return res.status(401).json(openAiError(401, 'authentication_error', 'GitHub Copilot token not available'));
  }

  const { signal, cleanup } = abortOnDisconnect(res);
  let upstream: Response | undefined;
  // Once a reader owns the body it decides whether to drain (keep-alive) or destroy.
  let bodyOwned = false;
  let usedTokens = 0;
  try {
    await refreshModelCatalog({ signal });
    if (signal.aborted) {
      return;
    }
    const model = resolveModel(request.model);
    const stream = request.stream === true;
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
      res.setHeader('X-Proxy-Resolved-Model', model);
    }
    const { body: outbound, warnings } = modernizeRequest(request as OpenAICompletionRequest & Record<string, unknown>);
    if (warnings.length > 0) {
      res.setHeader('X-Proxy-Warnings', warnings.join(', '));
    }
    trackRequest(sessionId);

    upstream = await upstreamFetch(resolveCopilotChatEndpoint(), {
      method: 'POST',
      headers: buildCopilotHeaders(copilotToken.token, {
        stream,
        hasImages: hasImageParts(request.messages),
      }),
      // Only the model (and the deprecated token field) change; everything else passes through.
      body: JSON.stringify({ ...outbound, model }),
      signal,
      size: MAX_RESPONSE_BYTES,
    });
    res.set(forwardableUpstreamHeaders(upstream));

    if (!upstream.ok || !stream) {
      bodyOwned = true;
      const body = await readJson(upstream);
      if (signal.aborted || res.destroyed) {
        return;
      }
      if (upstream.ok) {
        usedTokens = totalTokens(body.usage);
      }
      return res.status(upstream.status).json(body);
    }

    if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
      throw new SseRelayError('did not return an event stream');
    }
    let terminated = false;
    bodyOwned = true;
    const relay = createSseRelay(upstream);
    for await (const frame of relay.frames()) {
      if (signal.aborted || res.destroyed) {
        return;
      }
      if (frame.data === '[DONE]') {
        terminated = true;
      } else if (frame.data) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.data);
        } catch {
          throw new SseRelayError('returned malformed stream data');
        }
        if (isJsonObject(parsed)) {
          usedTokens = totalTokens(parsed.usage) || usedTokens;
          if (parsed.error !== undefined) {
            terminated = true;
          }
        }
      }
      if (terminated) {
        relay.complete();
      }
      if (!res.headersSent) {
        res.status(200).set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
      }
      if (!await writeResponse(res, frame.raw)) {
        return;
      }
      if (terminated) {
        break;
      }
    }
    if (!signal.aborted && !res.destroyed) {
      res.end();
    }
  } catch (error) {
    if (signal.aborted || res.destroyed) {
      return;
    }
    logger.error('OpenAI chat completion failed');
    const { status, body } = toOpenAiErrorResponse(error);
    if (!res.headersSent) {
      return res.status(status).json(body);
    }
    if (await writeResponse(res, `data: ${JSON.stringify(body)}\n\n`)) {
      res.end();
    }
  } finally {
    if (upstream && !bodyOwned) {
      destroyUpstreamBody(upstream);
    }
    trackTokens(sessionId, usedTokens);
    cleanup();
  }
});
