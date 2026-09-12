import { Response } from 'node-fetch';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { destroyUpstreamBody, drainUpstreamBody, upstreamAbortReason } from './upstream-fetch.js';

export const MAX_SSE_FRAME_BYTES = 1024 * 1024;

export class SseRelayError extends Error {
  readonly status = 502;

  constructor(message: string) {
    super(message);
    this.name = 'SseRelayError';
  }
}

export interface SseFrame {
  /** The complete frame exactly as received, including its terminator. */
  raw: string;
  /** Joined `data:` payload, or an empty string for comment/keepalive frames. */
  data: string;
}

export interface SseRelay {
  /** Frames exactly as received. Ends with an error if EOF arrives before `complete()`. */
  frames(): AsyncGenerator<SseFrame>;
  /**
   * Mark the stream logically finished (e.g. after `message_stop` or `[DONE]`)
   * before leaving the loop, so the connection is drained and kept alive
   * instead of destroyed. Leaving without it cancels the upstream request.
   */
  complete(): void;
}

/**
 * Split an upstream SSE body into complete frames without altering bytes.
 * The caller owns termination semantics; see {@link SseRelay.complete}.
 */
export function createSseRelay(response: Response): SseRelay {
  let completed = false;
  return {
    complete() {
      completed = true;
    },
    async *frames() {
      const body = response.body as Readable | null;
      if (!body) {
        throw new SseRelayError('returned an empty stream');
      }
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '';
      try {
        // destroyOnReturn=false: leaving the loop must not kill a reusable socket.
        for await (const chunk of body.iterator({ destroyOnReturn: false })) {
          try {
            pending += decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, {
              stream: true,
            });
          } catch {
            throw new SseRelayError('returned invalid UTF-8');
          }
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
            const end = boundary.index + boundary[0].length;
            const raw = pending.slice(0, end);
            pending = pending.slice(end);
            if (Buffer.byteLength(raw) > MAX_SSE_FRAME_BYTES) {
              throw new SseRelayError('event exceeded the buffer limit');
            }
            const data = raw
              .split(/\r\n|\r|\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).replace(/^ /, ''))
              .join('\n');
            yield { raw, data };
            if (completed) {
              return;
            }
          }
          if (Buffer.byteLength(pending) > MAX_SSE_FRAME_BYTES) {
            throw new SseRelayError('event exceeded the buffer limit');
          }
        }
        if (!completed) {
          throw new SseRelayError('ended before its completion marker');
        }
      } catch (error) {
        throw upstreamAbortReason(response) ?? error;
      } finally {
        if (completed) {
          drainUpstreamBody(response);
        } else {
          destroyUpstreamBody(response);
        }
      }
    },
  };
}
