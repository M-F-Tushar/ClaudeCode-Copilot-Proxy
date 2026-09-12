import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { config } from '../config/index.js';
import { CopilotToken } from '../types/github.js';
import { getUsage } from '../services/usage-service.js';

let token: CopilotToken;
const ensureToken = jest.fn(async () => token);
jest.unstable_mockModule('../services/auth-service.js', () => ({
  ensureCopilotToken: ensureToken,
  getCopilotToken: () => token,
  isTokenValid: () => false,
}));
const { openaiRoutes } = await import('./openai.js');
const { setCatalogForTesting } = await import('../services/model-catalog.js');

describe('OpenAI-compatible relay', () => {
  let upstream: http.Server;
  let complete: http.RequestListener;
  let app: express.Express;
  let session: string;
  let sequence = 0;
  let paths: string[];
  let bodies: Record<string, unknown>[];
  let sentHeaders: http.IncomingHttpHeaders[];
  const originalEndpoint = config.copilot.chatEndpointOverride;
  const originalSelection = config.anthropic.modelSelection;
  const originalTimeout = config.upstream.timeoutMs;
  const payload = {
    model: 'gpt-5.5', messages: [{ role: 'user', content: 'Hello' }],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    future_option: { keep: true },
  };
  const completion = {
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'gpt-5.5',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };

  beforeEach(async () => {
    session = `openai-relay-${sequence++}`;
    paths = [];
    bodies = [];
    sentHeaders = [];
    ensureToken.mockClear();
    config.anthropic.modelSelection = 'strict';
    config.upstream.timeoutMs = 1000;
    complete = (_req, res) => res.end(JSON.stringify(completion));
    upstream = http.createServer((req, res) => {
      res.setHeader('Connection', 'close');
      paths.push(req.url!);
      if (req.url === '/models') {
        res.end(JSON.stringify({ data: [
          { id: 'gpt-5.5', vendor: 'OpenAI', capabilities: { type: 'chat' } },
          { id: 'gpt-responses-only', vendor: 'OpenAI', supported_endpoints: ['/responses'], capabilities: { type: 'chat' } },
          { id: 'claude-sonnet-5', vendor: 'Anthropic', supported_endpoints: ['/v1/messages', '/chat/completions'],
            capabilities: { type: 'chat' } },
          { id: 'text-embedding-3-small', vendor: 'OpenAI', capabilities: { type: 'embeddings' } },
        ] }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        sentHeaders.push(req.headers);
        complete(req, res);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    config.copilot.chatEndpointOverride = `${api}/chat/completions`;
    token = {
      token: 'server-copilot-token', expires_at: Date.now() / 1000 + 3600, refresh_in: 300,
      chat_enabled: true, sku: 'test', telemetry: '', tracking_id: '', endpoints: { api },
    };
    setCatalogForTesting([]);
    app = express().use(express.json());
    app.use((_req, res, next) => { res.locals.sessionId = session; next(); });
    app.use('/v1', openaiRoutes);
  });

  afterEach(async () => {
    config.copilot.chatEndpointOverride = originalEndpoint;
    config.anthropic.modelSelection = originalSelection;
    config.upstream.timeoutMs = originalTimeout;
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    setCatalogForTesting([]);
  });

  it('relays buffered completions unchanged, refreshing credentials once and counting usage once', async () => {
    const response = await request(app).post('/v1/chat/completions')
      .set('Authorization', 'Bearer client-secret').send(payload);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(completion);
    expect(bodies[0]).toEqual(payload);
    expect(response.headers['x-proxy-warnings']).toBeUndefined();
    expect(sentHeaders[0].authorization).toBe('Bearer server-copilot-token');
    expect(sentHeaders[0]['copilot-integration-id']).toBeDefined();
    expect(ensureToken).toHaveBeenCalledTimes(1);
    expect(paths).toEqual(['/models', '/chat/completions']);
    expect(getUsage(session)).toMatchObject({ requestCount: 1, tokenCount: 7 });
    expect(response.headers['x-proxy-resolved-model']).toBe('gpt-5.5');
  });

  it('renames the deprecated max_tokens field only when the modern one is absent', async () => {
    await request(app).post('/v1/chat/completions').send({ ...payload, max_tokens: 64 });
    expect(bodies[0].max_tokens).toBeUndefined();
    expect(bodies[0].max_completion_tokens).toBe(64);
    await request(app).post('/v1/chat/completions').send({ ...payload, max_tokens: 64, max_completion_tokens: 32 });
    expect(bodies[1].max_tokens).toBe(64);
    expect(bodies[1].max_completion_tokens).toBe(32);
  });

  it('surfaces plain-text upstream errors with their real status instead of a 502', async () => {
    complete = (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request\n');
    };
    const response = await request(app).post('/v1/chat/completions').send(payload);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 400, message: 'Bad Request' });
  });

  it('relays SSE frames byte-for-byte, stops at [DONE], records usage and keeps the socket reusable', async () => {
    const sse = 'data: {"id":"c","choices":[{"index":0,"delta":{"content":"He"}}]}\r\n\r\n'
      + ': keepalive\r\n\r\n'
      + 'data: {"id":"c","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}],'
      + '"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\r\n\r\n'
      + 'data: [DONE]\r\n\r\n';
    let upstreamClosed = false;
    let finishUpstream!: () => void;
    complete = (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.on('close', () => { upstreamClosed = true; });
      finishUpstream = () => res.end();
      for (const byte of Buffer.from(sse)) res.write(Buffer.from([byte]));
      // Connection intentionally left open after [DONE].
    };
    const response = await request(app).post('/v1/chat/completions').send({ ...payload, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toBe(sse);
    expect(sentHeaders[0].accept).toBe('text/event-stream');
    expect(getUsage(session)).toMatchObject({ requestCount: 1, tokenCount: 7 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(upstreamClosed).toBe(false);
    finishUpstream();
  });

  it('refuses models Copilot serves only through other APIs before spending a request', async () => {
    const response = await request(app).post('/v1/chat/completions')
      .send({ ...payload, model: 'gpt-responses-only' });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('/responses');
    expect(paths).toEqual(['/models']);
  });

  it('preserves upstream error status and body instead of a generic 500', async () => {
    const error = { error: { message: 'model_not_supported', code: 'model_not_supported' } };
    complete = (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json', 'x-request-id': 'req-1', 'Set-Cookie': 'a=b' });
      res.end(JSON.stringify(error));
    };
    const response = await request(app).post('/v1/chat/completions').send({ ...payload, model: 'gpt-4' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual(error);
    expect(response.headers['x-request-id']).toBe('req-1');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(bodies[0].model).toBe('gpt-4');
  });

  it('resolves Claude aliases like Claude Code traffic and enables vision for image parts', async () => {
    const response = await request(app).post('/v1/chat/completions').send({
      model: 'sonnet',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] }],
    });
    expect(response.status).toBe(200);
    expect(bodies[0].model).toBe('claude-sonnet-5');
    expect(sentHeaders[0]['copilot-vision-request']).toBe('true');
    expect(response.headers['x-proxy-resolved-model']).toBe('claude-sonnet-5');
  });

  it('rejects unavailable strict Claude IDs before spending a request', async () => {
    const response = await request(app).post('/v1/chat/completions')
      .send({ ...payload, model: 'claude-invented-model' });
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('invalid_request_error');
    expect(paths).toEqual(['/models']);
  });

  it('reports truncated or malformed streams as errors without inventing [DONE]', async () => {
    complete = (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      res.end('data: private-prompt-not-json\n\n');
    };
    const response = await request(app).post('/v1/chat/completions').send({ ...payload, stream: true });
    expect(response.text).toContain('"upstream_error"');
    expect(response.text).not.toContain('private-prompt-not-json');
    expect(response.text).not.toContain('[DONE]');
    expect(getUsage(session)?.requestCount).toBe(1);
  });

  it('lists only chat-completions models from the live catalog in OpenAI format', async () => {
    const response = await request(app).get('/v1/models');
    expect(response.status).toBe(200);
    expect(response.body.object).toBe('list');
    expect(response.body.data.map((model: { id: string }) => model.id)).toEqual(['gpt-5.5', 'claude-sonnet-5']);
    expect(response.body.data[1].owned_by).toBe('Anthropic');
  });

  it('cancels the upstream request when the client disconnects', async () => {
    let started!: () => void;
    let stopped!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => { started = resolve; });
    const upstreamStopped = new Promise<void>((resolve) => { stopped = resolve; });
    complete = (_req, res) => { res.on('close', stopped); started(); };
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = http.request({
        hostname: '127.0.0.1', port: (server.address() as AddressInfo).port,
        path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' },
      });
      client.on('error', () => undefined);
      client.end(JSON.stringify({ ...payload, stream: true }));
      await upstreamStarted;
      client.destroy();
      await upstreamStopped;
      expect(getUsage(session)?.requestCount).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
