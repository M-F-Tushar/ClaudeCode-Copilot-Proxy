/**
 * Anthropic API routes - the endpoints Claude Code talks to.
 *
 * Implements the subset of the Anthropic Messages API that Claude Code uses:
 * `POST /v1/messages` (streaming and buffered), `POST /v1/messages/count_tokens`,
 * `GET /v1/models` and `GET /v1/models/:model`.
 */

import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  ensureCopilotToken,
  getCopilotToken,
  isTokenValid,
} from '../services/auth-service.js';
import {
  CopilotApiError,
  createAnthropicError,
  makeAnthropicCompletionRequest,
  streamAnthropicMessage,
} from '../services/anthropic-service.js';
import {
  getAvailableModels,
  getModelById,
  mapClaudeModelToCopilot,
} from '../utils/model-mapper.js';
import { refreshModelCatalog } from '../services/model-catalog.js';
import {
  AnthropicCountTokensRequest,
  AnthropicError,
  AnthropicMessageRequest,
  AnthropicStreamEvent,
} from '../types/anthropic.js';
import { logger } from '../utils/logger.js';
import { trackRequest, trackTokens } from '../services/usage-service.js';
import { abortOnDisconnect, writeResponse } from '../utils/response-stream.js';
import { UpstreamTimeoutError } from '../utils/upstream-fetch.js';
import {
  inspectRequestCompatibility,
  RequestCompatibilityError,
} from '../utils/request-policy.js';
import { ContextWindowError } from '../utils/token-budget.js';
import { estimateInputTokensDetailed } from '../utils/token-estimator.js';
import { config } from '../config/index.js';
import {
  isJsonObject, mergeNativeUsage, nativeFrames, nativeResponseHeaders, nativeTokenTotal,
  NativeRequestHeaders, postNativeAnthropic, readNativeJson, usesNativeAnthropic,
} from '../services/native-anthropic.js';
import { destroyUpstreamBody } from '../utils/upstream-fetch.js';

export const anthropicRoutes = express.Router();

/**
 * Ensure a usable GitHub Copilot token is available, refreshing it when the
 * cached one has expired.
 */
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
  } catch (error) {
    logger.warn('Copilot authentication unavailable');
    return res
      .status(401)
      .json(
        createAnthropicError(
          'authentication_error',
          'GitHub Copilot authentication required. Please authenticate at /auth.html'
        )
      );
  }
};

/**
 * Validate an incoming Messages API request.
 *
 * @returns An Anthropic error body when the request is invalid, otherwise null
 */
function validateMessageRequest(request: AnthropicMessageRequest): AnthropicError | null {
  if (!request || typeof request !== 'object') {
    return createAnthropicError('invalid_request_error', 'Request body must be a JSON object');
  }

  if (!request.model || typeof request.model !== 'string') {
    return createAnthropicError('invalid_request_error', 'model: field required');
  }

  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return createAnthropicError('invalid_request_error', 'messages: field required');
  }

  if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens <= 0) {
    return createAnthropicError(
      'invalid_request_error',
      'max_tokens: field required and must be a positive integer'
    );
  }

  for (const message of request.messages) {
    // `system` is permitted by the mid-conversation-system beta that Claude Code sends.
    if (!message || !['user', 'assistant', 'system'].includes(message.role)) {
      return createAnthropicError(
        'invalid_request_error',
        'messages: each message must have a valid role (user, assistant or system)'
      );
    }
    if (message.content === undefined || message.content === null) {
      return createAnthropicError(
        'invalid_request_error',
        'messages: each message must have content'
      );
    }
  }

  return null;
}

/**
 * Translate a thrown error into an Anthropic error body plus HTTP status.
 */
function toAnthropicErrorResponse(error: unknown): { status: number; body: AnthropicError } {
  if (error instanceof RequestCompatibilityError || error instanceof ContextWindowError ||
      (error instanceof Error && error.name === 'ModelSelectionError')) {
    return { status: 400, body: createAnthropicError('invalid_request_error', error.message) };
  }
  if (error instanceof UpstreamTimeoutError) {
    return { status: 504, body: createAnthropicError('api_error', error.message) };
  }
  if (error instanceof CopilotApiError) {
    return {
      status: error.status,
      body: createAnthropicError(error.errorType, error.message),
    };
  }

  return {
    status: 500,
    body: createAnthropicError(
      'api_error',
      'Internal server error'
    ),
  };
}

function setModelHeader(res: express.Response, name: string, model: string): void {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
    res.setHeader(name, model);
  }
}

function setCompatibilityHeaders(
  res: express.Response,
  request: AnthropicMessageRequest
): void {
  const warnings = inspectRequestCompatibility(request);
  const resolvedModel = mapClaudeModelToCopilot(request.model);
  setModelHeader(res, 'X-Proxy-Resolved-Model', resolvedModel);
  if (warnings.length > 0) {
    res.setHeader('X-Proxy-Warnings', warnings.join(', '));
  }
}

function requestHeaders(req: express.Request): NativeRequestHeaders {
  return { version: req.get('anthropic-version'), beta: req.get('anthropic-beta') };
}

// GET /v1/models - list every Copilot model the account can use
anthropicRoutes.get('/models', requireAuth, async (_req, res) => {
  await refreshModelCatalog();
  res.json(getAvailableModels());
});

// GET /v1/models/:model - describe a single model
anthropicRoutes.get('/models/:model', requireAuth, async (req, res) => {
  await refreshModelCatalog();
  const model = getModelById(req.params.model);

  if (!model) {
    return res
      .status(404)
      .json(createAnthropicError('not_found_error', `model: ${req.params.model} not found`));
  }

  return res.json(model);
});

// POST /v1/messages/count_tokens - native provider counting or explicit local estimate
anthropicRoutes.post('/messages/count_tokens', requireAuth, async (req, res) => {
  const request = (req.body ?? {}) as AnthropicCountTokensRequest;
  const { model, messages, system, tools } = request;
  if (!Array.isArray(messages)) {
    return res.status(400).json(
      createAnthropicError('invalid_request_error', 'messages: field required')
    );
  }

  const { signal, cleanup } = abortOnDisconnect(res);
  try {
    await refreshModelCatalog({ signal });
    if (signal.aborted) return;
    const resolvedModel = mapClaudeModelToCopilot(model || config.anthropic.defaultModel);
    setModelHeader(res, 'X-Proxy-Resolved-Model', resolvedModel);
    if (usesNativeAnthropic(resolvedModel)) {
      const token = getCopilotToken();
      if (!token) throw new CopilotApiError(401, 'GitHub Copilot token not available');
      const upstream = await postNativeAnthropic(
        request, resolvedModel, token.token, requestHeaders(req), signal, true
      );
      const body = await readNativeJson(upstream);
      if (signal.aborted || res.destroyed) return;
      if (upstream.ok && (!Number.isSafeInteger(body.input_tokens) || Number(body.input_tokens) < 0)) {
        throw new CopilotApiError(502, 'Copilot returned invalid native token counting data');
      }
      res.set(nativeResponseHeaders(upstream));
      res.setHeader('X-Proxy-Transport', 'native');
      if (upstream.ok) res.setHeader('X-Proxy-Token-Count', 'upstream');
      return res.status(upstream.status).json(body);
    }
    const estimate = estimateInputTokensDetailed(messages, system, tools, resolvedModel);
    res.setHeader('X-Proxy-Transport', 'chat');
    res.setHeader('X-Proxy-Token-Count', estimate.source);
    return res.json({ input_tokens: estimate.inputTokens });
  } catch (error) {
    if (signal.aborted || res.destroyed) return;
    const { status, body } = toAnthropicErrorResponse(error);
    return res.status(status).json(body);
  } finally {
    cleanup();
  }
});

// POST /v1/messages - the main Claude Code endpoint
anthropicRoutes.post('/messages', requireAuth, async (req, res) => {
  const sessionId: string = res.locals.sessionId || randomUUID();
  const request = req.body as AnthropicMessageRequest;

  const validationError = validateMessageRequest(request);
  if (validationError) {
    return res.status(400).json(validationError);
  }

  const copilotToken = getCopilotToken();
  if (!copilotToken) {
    return res
      .status(401)
      .json(createAnthropicError('authentication_error', 'GitHub Copilot token not available'));
  }

  const { signal, cleanup } = abortOnDisconnect(res);
  try {
    await refreshModelCatalog({ signal });
    if (signal.aborted) {
      return;
    }
    const resolvedModel = mapClaudeModelToCopilot(request.model);
    if (usesNativeAnthropic(resolvedModel)) {
      setModelHeader(res, 'X-Proxy-Resolved-Model', resolvedModel);
      res.setHeader('X-Proxy-Transport', 'native');
      if (resolvedModel !== request.model) res.setHeader('X-Proxy-Warnings', 'model_resolved');
      trackRequest(sessionId);
      return await handleNativeMessage(
        res, request, resolvedModel, copilotToken.token, sessionId, signal, requestHeaders(req)
      );
    }
    res.setHeader('X-Proxy-Transport', 'chat');
    setCompatibilityHeaders(res, request);
    trackRequest(sessionId);
    if (request.stream) {
      return await handleStreamingMessage(res, request, copilotToken.token, sessionId, signal);
    }
    const response = await makeAnthropicCompletionRequest(request, copilotToken.token, signal);
    trackTokens(sessionId, response.usage.input_tokens + response.usage.output_tokens);
    if (signal.aborted || res.destroyed) {
      return;
    }
    setModelHeader(res, 'X-Proxy-Actual-Model', response.model);
    return res.json(response);
  } catch (error) {
    if (signal.aborted || res.destroyed) {
      return;
    }
    logger.error('Anthropic completion failed');
    const { status, body } = toAnthropicErrorResponse(error);
    return res.status(status).json(body);
  } finally {
    cleanup();
  }
});

/**
 * Write a single Anthropic SSE event.
 */
function writeEvent(res: express.Response, event: AnthropicStreamEvent): Promise<boolean> {
  return writeResponse(res, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function handleNativeMessage(
  res: express.Response,
  request: AnthropicMessageRequest,
  model: string,
  token: string,
  sessionId: string,
  signal: AbortSignal,
  headers: NativeRequestHeaders
): Promise<void> {
  const upstream = await postNativeAnthropic(request, model, token, headers, signal);
  let usage: Record<string, unknown> = {};
  // Once a reader owns the body it decides whether to drain (keep-alive) or destroy.
  let bodyOwned = false;
  try {
    res.set(nativeResponseHeaders(upstream));
    if (!upstream.ok || !request.stream) {
      bodyOwned = true;
      const body = await readNativeJson(upstream);
      if (signal.aborted || res.destroyed) return;
      if (upstream.ok) {
        if (body.type !== 'message' || body.role !== 'assistant' || !Array.isArray(body.content)) {
          throw new CopilotApiError(502, 'Copilot returned an invalid native message');
        }
        usage = mergeNativeUsage(usage, body.usage);
        if (typeof body.model === 'string') setModelHeader(res, 'X-Proxy-Actual-Model', body.model);
      }
      res.status(upstream.status).json(body);
      return;
    }
    if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
      throw new CopilotApiError(502, 'Copilot did not return a native event stream');
    }
    let started = false;
    let finished = false;
    bodyOwned = true;
    for await (const frame of nativeFrames(upstream)) {
      if (signal.aborted || res.destroyed) return;
      const event = frame.event;
      if (event?.type === 'message_start') {
        if (started || !isJsonObject(event.message)) {
          throw new CopilotApiError(502, 'Copilot returned an invalid native message_start');
        }
        started = true;
        usage = mergeNativeUsage(usage, event.message.usage);
        if (!res.headersSent && typeof event.message.model === 'string') {
          setModelHeader(res, 'X-Proxy-Actual-Model', event.message.model);
        }
      } else if (event?.type === 'message_delta') {
        if (!started) throw new CopilotApiError(502, 'Copilot sent a native delta before message_start');
        usage = mergeNativeUsage(usage, event.usage);
        finished = isJsonObject(event.delta) && typeof event.delta.stop_reason === 'string';
      } else if (event?.type === 'message_stop' && (!started || !finished)) {
        throw new CopilotApiError(502, 'Copilot ended a native message before its final delta');
      }
      if (!res.headersSent) {
        res.status(200).set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
      }
      if (!await writeResponse(res, frame.raw)) return;
    }
    if (!signal.aborted && !res.destroyed) res.end();
  } catch (error) {
    if (signal.aborted || res.destroyed) return;
    if (!res.headersSent) throw error;
    logger.error('Native Anthropic streaming failed');
    const { body } = toAnthropicErrorResponse(error);
    if (await writeEvent(res, { type: 'error', error: body.error })) res.end();
  } finally {
    if (!bodyOwned) destroyUpstreamBody(upstream);
    trackTokens(sessionId, nativeTokenTotal(usage));
  }
}

/**
 * Stream a response to Claude Code in Anthropic SSE format.
 */
async function handleStreamingMessage(
  res: express.Response,
  request: AnthropicMessageRequest,
  copilotToken: string,
  sessionId: string,
  signal: AbortSignal
): Promise<void> {
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    for await (const event of streamAnthropicMessage(request, copilotToken, signal)) {
      if (signal.aborted || res.destroyed) {
        logger.debug('Client disconnected, aborting stream');
        break;
      }

      if (!res.headersSent) {
        // Headers are only committed once the upstream call succeeds, so that
        // early failures can still be reported with a real status code.
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (event.type === 'message_start') {
          setModelHeader(res, 'X-Proxy-Actual-Model', event.message.model);
        }
        res.flushHeaders();
      }

      if (event.type === 'message_start') {
        inputTokens = event.message.usage.input_tokens;
      } else if (event.type === 'message_delta') {
        inputTokens = event.usage.input_tokens ?? inputTokens;
        outputTokens = event.usage.output_tokens;
      }

      if (!await writeEvent(res, event)) {
        break;
      }
    }

    if (!signal.aborted && !res.destroyed) {
      res.end();
    }
  } catch (error) {
    logger.error('Anthropic streaming failed');
    const { status, body } = toAnthropicErrorResponse(error);

    if (signal.aborted || res.destroyed) {
      return;
    }

    if (!res.headersSent) {
      res.status(status).json(body);
      return;
    }

    if (await writeEvent(res, { type: 'error', error: body.error })) {
      res.end();
    }
  } finally {
    trackTokens(sessionId, inputTokens + outputTokens);
  }
}
