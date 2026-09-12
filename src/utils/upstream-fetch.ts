import fetch, { RequestInit, Response } from 'node-fetch';
import { Readable } from 'node:stream';
import { config } from '../config/index.js';

export class UpstreamTimeoutError extends Error {
  readonly status = 504;

  constructor() {
    super('Upstream request timed out');
    this.name = 'UpstreamTimeoutError';
  }
}

export interface UpstreamFetchOptions {
  maxRetries?: number;
}

const responseSignals = new WeakMap<Response, AbortSignal>();

/** Preserve timeout versus caller cancellation when node-fetch rejects a body read. */
export function upstreamAbortReason(response: Response): unknown {
  const signal = responseSignals.get(response);
  return signal?.aborted ? signal.reason : undefined;
}

function abortError(): Error {
  const error = new Error('Upstream request aborted');
  error.name = 'AbortError';
  return error;
}

export function destroyUpstreamBody(response: Response): void {
  (response.body as Readable | null)?.destroy();
}

/**
 * Discard the remainder of a logically complete body so the TLS connection
 * returns to the keep-alive pool. Destroying it instead forces every following
 * request to pay a new handshake. The fetch deadline still bounds the drain.
 */
export function drainUpstreamBody(response: Response): void {
  const body = response.body as Readable | null;
  if (!body || body.destroyed || body.readableEnded) {
    return;
  }
  body.on('error', () => undefined);
  body.resume();
}

/**
 * Upstream headers safe to relay to clients: request correlation, retry
 * guidance and rate-limit telemetry. Cookies, content framing and hop-by-hop
 * headers are deliberately excluded.
 */
export function forwardableUpstreamHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (['request-id', 'x-request-id', 'retry-after', 'retry-after-ms'].includes(name) ||
        name.startsWith('anthropic-ratelimit-') || name.startsWith('x-ratelimit-')) {
      headers[name] = value;
    }
  });
  return headers;
}

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get('retry-after');
  if (value !== null) {
    const seconds = Number(value);
    if (value.trim() && Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
      return Math.max(0, date - Date.now());
    }
  }
  return Math.min(250 * 2 ** attempt, config.upstream.maxRetryDelayMs);
}

/**
 * A single deadline covers headers, retries and body consumption. Callers must
 * consume or destroy the body; observing completion must never start it flowing.
 * Network failures are never replayed: a paid generation may already have begun.
 */
export async function upstreamFetch(
  url: string | URL,
  init: RequestInit = {},
  options: UpstreamFetchOptions = {}
): Promise<Response> {
  const controller = new AbortController();
  const deadline = Date.now() + config.upstream.timeoutMs;
  const callerSignal = init.signal;
  const onAbort = () => controller.abort(abortError());
  const timer = setTimeout(
    () => controller.abort(new UpstreamTimeoutError()),
    config.upstream.timeoutMs
  );
  timer.unref?.();
  callerSignal?.addEventListener('abort', onAbort);
  if (callerSignal?.aborted) {
    onAbort();
  }

  let body: Readable | null = null;
  const cleanup = () => {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onAbort);
    body?.removeListener('end', cleanup);
    body?.removeListener('close', cleanup);
    body?.removeListener('error', cleanup);
  };
  const replayable =
    init.body == null ||
    typeof init.body === 'string' ||
    Buffer.isBuffer(init.body) ||
    init.body instanceof URLSearchParams;
  const maxRetries = Math.max(
    0,
    Math.min(3, options.maxRetries ?? config.upstream.maxRetries)
  );

  try {
    for (let attempt = 0; ; attempt++) {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (controller.signal.aborted) {
        destroyUpstreamBody(response);
        throw controller.signal.reason;
      }

      const delay = retryDelay(response, attempt);
      if (
        replayable &&
        attempt < maxRetries &&
        [429, 502, 503, 504].includes(response.status) &&
        delay <= config.upstream.maxRetryDelayMs &&
        Date.now() + delay < deadline
      ) {
        destroyUpstreamBody(response);
        await new Promise<void>((resolve, reject) => {
          const aborted = () => {
            clearTimeout(wait);
            reject(controller.signal.reason);
          };
          const wait = setTimeout(() => {
            controller.signal.removeEventListener('abort', aborted);
            resolve();
          }, delay);
          controller.signal.addEventListener('abort', aborted, { once: true });
          if (controller.signal.aborted) {
            aborted();
          }
        });
        continue;
      }

      body = response.body as Readable | null;
      if (!body || body.destroyed || body.readableEnded) {
        cleanup();
      } else {
        body.once('end', cleanup);
        body.once('close', cleanup);
        body.once('error', cleanup);
      }
      responseSignals.set(response, controller.signal);
      return response;
    }
  } catch (error) {
    cleanup();
    throw controller.signal.aborted ? controller.signal.reason : error;
  }
}
