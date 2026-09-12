import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { config } from '../config/index.js';
import { CopilotToken } from '../types/github.js';
import { getUsage } from '../services/usage-service.js';

let token: CopilotToken;
jest.unstable_mockModule('../services/auth-service.js', () => ({
  ensureCopilotToken: async () => token,
  getCopilotToken: () => token,
  isTokenValid: () => true,
}));
const { anthropicRoutes } = await import('./anthropic.js');
const { setCatalogForTesting } = await import('../services/model-catalog.js');
const { usesNativeAnthropic } = await import('../services/native-anthropic.js');

const payload = {
  model: 'claude-sonnet-5', max_tokens: 64000,
  messages: [{ role: 'user', content: 'Synthetic native request' }],
};
const usage = {
  input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 40, cache_read_input_tokens: 100,
  cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 },
};
const message = {
  id: 'msg_native', type: 'message', role: 'assistant', model: payload.model,
  content: [
    { type: 'thinking', thinking: 'Synthetic reasoning', signature: 'opaque-signature' },
    { type: 'text', text: 'NATIVE_OK', citations: [] },
  ],
  stop_reason: 'end_turn', stop_sequence: null, usage,
};
function frame(type: string, fields: Record<string, unknown> = {}): string {
  return `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;
}
const start = () => frame('message_start', { message: { ...message, content: [], usage: { ...usage, output_tokens: 0 } } });
const end = () => frame('message_delta', {
  delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 },
}) + frame('message_stop');

describe('native Anthropic gateway contracts', () => {
  let upstream: http.Server;
  let downstream: http.Server;
  let complete: http.RequestListener;
  let paths: string[];
  let bodies: Record<string, unknown>[];
  let sentHeaders: http.IncomingHttpHeaders[];
  let session: string;
  let sequence = 0;
  let endpoints: string[];
  const originalAnthropic = { ...config.anthropic };
  const originalCopilot = { ...config.copilot };
  const originalTimeout = config.upstream.timeoutMs;

  beforeEach(async () => {
    session = `native-test-${sequence++}`;
    paths = [];
    bodies = [];
    sentHeaders = [];
    endpoints = ['/v1/messages', '/chat/completions'];
    config.anthropic.upstreamMode = 'auto';
    config.anthropic.modelSelection = 'strict';
    config.anthropic.unsupportedFeatures = 'reject';
    config.copilot.chatEndpointOverride = undefined;
    config.copilot.messagesEndpointOverride = undefined;
    config.upstream.timeoutMs = 1000;
    complete = (_req, res) => res.end(JSON.stringify(message));
    upstream = http.createServer((req, res) => {
      res.setHeader('Connection', 'close');
      paths.push(req.url!);
      if (req.url === '/models') {
        res.end(JSON.stringify({ data: [{
          id: payload.model, vendor: 'Anthropic', supported_endpoints: endpoints,
          capabilities: { type: 'chat', limits: {
            max_context_window_tokens: 100, max_output_tokens: 64000, max_non_streaming_output_tokens: 16000,
          } },
        }] }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        sentHeaders.push(req.headers);
        complete(req, res);
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    token = {
      token: 'server-copilot-token', expires_at: Date.now() / 1000 + 3600, refresh_in: 300,
      chat_enabled: true, sku: 'test', telemetry: '', tracking_id: '',
      endpoints: { api: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` },
    };
    setCatalogForTesting([]);
    const app = express().use(express.json());
    app.use((_req, res, next) => { res.locals.sessionId = session; next(); });
    app.use('/v1', anthropicRoutes);
    downstream = http.createServer(app);
    await new Promise<void>(resolve => downstream.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    Object.assign(config.anthropic, originalAnthropic);
    Object.assign(config.copilot, originalCopilot);
    config.upstream.timeoutMs = originalTimeout;
    upstream.closeAllConnections();
    downstream.closeAllConnections();
    await Promise.all([upstream, downstream].map(server =>
      new Promise<void>(resolve => server.close(() => resolve()))
    ));
    setCatalogForTesting([]);
  });

  it('uses advertised native routing and preserves reasoning/cache/future fields without heuristic clamping', async () => {
    const nativeRequest = {
      ...payload,
      thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
      system: [{ type: 'text', text: 'x'.repeat(5000), cache_control: { type: 'ephemeral', ttl: '1h' } }],
      tools: [{ name: 'Read'.repeat(30), input_schema: { type: 'object' }, defer_loading: true }],
      future_native_option: { preserve: true },
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Prior reasoning', signature: 'unchanged' }] },
        ...payload.messages,
      ],
    };
    const response = await request(downstream).post('/v1/messages?beta=true')
      .set('anthropic-version', '2023-06-01').set('anthropic-beta', 'test-beta-one,test-beta-two')
      .set('Authorization', 'Bearer client-secret').set('x-api-key', 'client-secret')
      .send(nativeRequest);
    expect(response.status).toBe(200);
    expect(paths).toEqual(['/models', '/v1/messages']);
    expect(bodies[0]).toEqual(nativeRequest);
    expect(response.body).toEqual(message);
    expect(response.headers['x-proxy-transport']).toBe('native');
    expect(response.headers['x-proxy-warnings']).toBeUndefined();
    expect(response.headers['x-proxy-actual-model']).toBe(payload.model);
    expect(sentHeaders[0]['anthropic-beta']).toBe('test-beta-one,test-beta-two');
    expect(sentHeaders[0]['anthropic-version']).toBe('2023-06-01');
    expect(sentHeaders[0].authorization).toBe('Bearer server-copilot-token');
    expect(sentHeaders[0]['x-api-key']).toBeUndefined();
    expect(getUsage(session)).toMatchObject({ requestCount: 1, tokenCount: 165 });
  });

  it('obtains provider token counts without local heuristics or extra generation requests', async () => {
    complete = (_req, res) => res.end(JSON.stringify({ input_tokens: 8028 }));
    const countRequest = {
      model: 'sonnet', messages: payload.messages, thinking: { type: 'adaptive' },
      system: 'Synthetic count request', tools: [],
    };
    const response = await request(downstream).post('/v1/messages/count_tokens')
      .set('anthropic-beta', 'count-beta').send(countRequest);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ input_tokens: 8028 });
    expect(response.headers['x-proxy-token-count']).toBe('upstream');
    expect(response.headers['x-proxy-transport']).toBe('native');
    expect(paths).toEqual(['/models', '/v1/messages/count_tokens']);
    expect(bodies[0]).toEqual({ ...countRequest, model: payload.model });
    expect(sentHeaders[0]['anthropic-beta']).toBe('count-beta');
    expect(getUsage(session)).toBeNull();
  });

  it('preserves nullable cache accounting without inventing cache hits', async () => {
    const body = { ...message, usage: {
      input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null,
    } };
    complete = (_req, res) => res.end(JSON.stringify(body));
    const response = await request(downstream).post('/v1/messages').send(payload);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(body);
    expect(getUsage(session)).toMatchObject({ tokenCount: 25 });
  });

  it('preserves nested tool-result images and enables the vision header', async () => {
    const nativeRequest = {
      ...payload,
      messages: [{ role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'call_1',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      }] }],
    };
    const response = await request(downstream).post('/v1/messages').send(nativeRequest);
    expect(response.status).toBe(200);
    expect(bodies[0]).toEqual(nativeRequest);
    expect(sentHeaders[0]['copilot-vision-request']).toBe('true');
  });

  it('does not substitute estimated counts when native counting is unavailable', async () => {
    const error = { type: 'error', error: { type: 'not_found_error', message: 'Counting unavailable' } };
    complete = (_req, res) => res.writeHead(404).end(JSON.stringify(error));
    const response = await request(downstream).post('/v1/messages/count_tokens').send({
      model: payload.model, messages: payload.messages,
    });
    expect(response.status).toBe(404);
    expect(response.body).toEqual(error);
    expect(response.headers['x-proxy-token-count']).toBeUndefined();
    expect(paths).toEqual(['/models', '/v1/messages/count_tokens']);
  });

  it('forwards native SSE frames unchanged, including signatures, unknown deltas and cache usage', async () => {
    const sse = start()
      + frame('ping')
      + frame('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
      + frame('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '\u4f60\u597d' } })
      + frame('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'opaque' } })
      + frame('content_block_delta', { index: 0, delta: { type: 'future_delta', data: 'unchanged' } })
      + frame('content_block_stop', { index: 0 })
      + frame('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
      + frame('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'NATIVE_OK' } })
      + frame('content_block_stop', { index: 1 }) + end();
    let upstreamClosed = false;
    let finishUpstream!: () => void;
    complete = (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.on('close', () => { upstreamClosed = true; });
      finishUpstream = () => res.end();
      for (const byte of Buffer.from(sse)) res.write(Buffer.from([byte]));
      // Deliberately keep the connection open after message_stop.
    };
    const response = await request(downstream).post('/v1/messages').send({ ...payload, stream: true });
    expect(response.status).toBe(200);
    expect(response.text).toBe(sse);
    expect(getUsage(session)).toMatchObject({ requestCount: 1, tokenCount: 165 });
    // A graceful stop must drain, not destroy, so the keep-alive socket stays reusable.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(upstreamClosed).toBe(false);
    finishUpstream();
  });

  it('preserves upstream error status/body and retry guidance without forwarding cookies', async () => {
    const errorBody = { type: 'error', error: { type: 'rate_limit_error', message: 'Synthetic limit' } };
    complete = (_req, res) => {
      res.writeHead(429, { 'Retry-After': '12', 'request-id': 'req-test', 'Set-Cookie': 'private=value' });
      res.end(JSON.stringify(errorBody));
    };
    const response = await request(downstream).post('/v1/messages').send(payload);
    expect(response.status).toBe(429);
    expect(response.body).toEqual(errorBody);
    expect(response.headers['retry-after']).toBe('12');
    expect(response.headers['request-id']).toBe('req-test');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(paths.filter(value => value === '/v1/messages')).toHaveLength(1);
    expect(paths).not.toContain('/chat/completions');
  });

  it('wraps plain-text upstream errors in the Anthropic envelope with the real status', async () => {
    complete = (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request\n');
    };
    const response = await request(downstream).post('/v1/messages').send(payload);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      type: 'error', error: { type: 'invalid_request_error', message: 'Bad Request' },
    });
  });

  it('preserves signature-only thinking, redacted content and partial tool JSON', async () => {
    const sse = start()
      + frame('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
      + frame('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } })
      + frame('content_block_stop', { index: 0 })
      + frame('content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-redacted-data' } })
      + frame('content_block_stop', { index: 1 })
      + frame('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} } })
      + frame('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } })
      + frame('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '"fixture.txt"}' } })
      + frame('content_block_stop', { index: 2 })
      + frame('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
      + frame('message_stop');
    complete = (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(sse);
    };
    const response = await request(downstream).post('/v1/messages').send({ ...payload, stream: true });
    expect(response.status).toBe(200);
    expect(response.text).toBe(sse);
  });

  it('reports truncated native streams as errors without inventing message_stop', async () => {
    complete = (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(start());
    };
    const response = await request(downstream).post('/v1/messages').send({ ...payload, stream: true });
    expect(response.text).toContain('event: error');
    expect(response.text).not.toContain('event: message_stop');
    expect(getUsage(session)?.requestCount).toBe(1);
  });

  it('forwards native stream errors once instead of reporting success', async () => {
    const sse = start() + frame('error', { error: { type: 'overloaded_error', message: 'Synthetic failure' } });
    complete = (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(sse);
    };
    const response = await request(downstream).post('/v1/messages').send({ ...payload, stream: true });
    expect(response.text).toBe(sse);
  });

  it('retains 504 timeout semantics while reading a stalled native JSON body', async () => {
    config.upstream.timeoutMs = 100;
    complete = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"input_tokens":');
    };
    const response = await request(downstream).post('/v1/messages/count_tokens').send({
      model: payload.model, messages: payload.messages,
    });
    expect(response.status).toBe(504);
    expect(response.body.error.type).toBe('api_error');
  });

  it('bounds malformed native SSE before sending successful response headers', async () => {
    complete = (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: ' + 'x'.repeat(1024 * 1024));
    };
    const response = await request(downstream).post('/v1/messages').send({ ...payload, stream: true });
    expect(response.status).toBe(502);
    expect(response.body.error).toBeDefined();
  });

  it('does not infer final success from an intermediate native message_delta', async () => {
    complete = (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(start() + frame('message_delta', {
        delta: { stop_reason: null }, usage: { output_tokens: 2 },
      }) + frame('message_stop'));
    };
    const response = await request(downstream).post('/v1/messages').send({ ...payload, stream: true });
    expect(response.text).toContain('event: error');
    expect(response.text).not.toContain('event: message_stop');
  });

  it.each([false, true])('cancels native upstream generation on disconnect (stream=%s)', async stream => {
    let started!: () => void;
    let stopped!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { started = resolve; });
    const upstreamStopped = new Promise<void>(resolve => { stopped = resolve; });
    complete = (_req, res) => { res.on('close', stopped); started(); };
    const client = http.request({
      hostname: '127.0.0.1', port: (downstream.address() as AddressInfo).port,
      path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    client.on('error', () => undefined);
    client.end(JSON.stringify({ ...payload, stream }));
    await upstreamStarted;
    client.destroy();
    await upstreamStopped;
    expect(paths).toEqual(['/models', '/v1/messages']);
  });

  it('does not guess native support and honors explicit chat/native selection', async () => {
    endpoints = ['/chat/completions'];
    await request(downstream).get('/v1/models');
    expect(usesNativeAnthropic(payload.model)).toBe(false);
    config.anthropic.upstreamMode = 'native';
    const response = await request(downstream).post('/v1/messages').send(payload);
    expect(response.status).toBe(400);
    expect(paths).toEqual(['/models']);
    config.copilot.messagesEndpointOverride = `${token.endpoints!.api}/custom/v1/messages`;
    expect(usesNativeAnthropic(payload.model)).toBe(true);
    config.anthropic.upstreamMode = 'chat';
    expect(usesNativeAnthropic(payload.model)).toBe(false);
  });

  it('keeps a pinned chat endpoint in chat mode unless explicitly changed', async () => {
    await request(downstream).get('/v1/models');
    expect(usesNativeAnthropic(payload.model)).toBe(true);
    config.copilot.chatEndpointOverride = 'http://127.0.0.1:9/custom/chat/completions';
    expect(usesNativeAnthropic(payload.model)).toBe(false);
    config.anthropic.upstreamMode = 'native';
    expect(usesNativeAnthropic(payload.model)).toBe(true);
  });
});
