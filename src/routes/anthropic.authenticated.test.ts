import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CopilotToken } from '../types/github.js';
import { config } from '../config/index.js';
import { getUsage } from '../services/usage-service.js';
import { resetTokenEstimatorForTesting } from '../utils/token-estimator.js';

let token: CopilotToken;
const ensureToken = jest.fn(async () => token);
jest.unstable_mockModule('../services/auth-service.js', () => ({
  ensureCopilotToken: ensureToken,
  getCopilotToken: () => token,
  isTokenValid: () => true,
}));
const { anthropicRoutes } = await import('./anthropic.js');
const { setCatalogForTesting } = await import('../services/model-catalog.js');

describe('authenticated Anthropic request lifecycle', () => {
  let upstream: http.Server;
  let downstream: http.Server;
  let complete: http.RequestListener;
  let paths: string[];
  let session: string;
  let sequence = 0;
  const originalEndpoint = config.copilot.chatEndpointOverride;
  const originalTimeout = config.upstream.timeoutMs;
  const originalSelection = config.anthropic.modelSelection;
  const originalStreaming = config.anthropic.streamUpstream;
  const originalUnsupported = config.anthropic.unsupportedFeatures;
  const payload = {
    model: 'claude-sonnet-5', max_tokens: 64,
    messages: [{ role: 'user', content: 'Hello' }],
  };

  beforeEach(async () => {
    session = `authenticated-route-${sequence++}`;
    paths = [];
    config.anthropic.modelSelection = 'strict';
    config.anthropic.streamUpstream = true;
    config.anthropic.unsupportedFeatures = 'warn';
    config.upstream.timeoutMs = 1000;
    resetTokenEstimatorForTesting();
    complete = (_req, res) => res.end(JSON.stringify({
      id: 'completion-test', model: 'claude-sonnet-5',
      choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }));
    upstream = http.createServer((req, res) => {
      res.setHeader('Connection', 'close');
      paths.push(req.url!);
      if (req.url === '/models') {
        res.end(JSON.stringify({ data: [{
          id: 'claude-sonnet-5', vendor: 'Anthropic',
          capabilities: {
            type: 'chat',
            limits: { max_output_tokens: 64000, max_context_window_tokens: 200000 },
          },
        }] }));
      } else {
        complete(req, res);
      }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    config.copilot.chatEndpointOverride = `${api}/chat/completions`;
    token = {
      token: 'test-only-token', expires_at: Date.now() / 1000 + 3600, refresh_in: 300,
      chat_enabled: true, sku: 'test', telemetry: '', tracking_id: '', endpoints: { api },
    };
    setCatalogForTesting([]);
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => { res.locals.sessionId = session; next(); });
    app.use('/v1', anthropicRoutes);
    downstream = http.createServer(app);
    await new Promise<void>(resolve => downstream.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    config.copilot.chatEndpointOverride = originalEndpoint;
    config.upstream.timeoutMs = originalTimeout;
    config.anthropic.modelSelection = originalSelection;
    config.anthropic.streamUpstream = originalStreaming;
    config.anthropic.unsupportedFeatures = originalUnsupported;
    upstream.closeAllConnections();
    downstream.closeAllConnections();
    await Promise.all([upstream, downstream].map(server =>
      new Promise<void>(resolve => server.close(() => resolve()))
    ));
    setCatalogForTesting([]);
    resetTokenEstimatorForTesting();
  });

  it('loads the catalog before model selection and counts buffered usage once', async () => {
    const response = await request(downstream).post('/v1/messages').send(payload);
    expect(response.status).toBe(200);
    expect(response.body.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(response.headers['x-proxy-resolved-model']).toBe('claude-sonnet-5');
    expect(response.headers['x-proxy-actual-model']).toBe('claude-sonnet-5');
    expect(paths).toEqual(['/models', '/chat/completions']);
    expect(getUsage(session)).toMatchObject({ requestCount: 1, tokenCount: 7 });
  });

  it('returns a structured 400 for unsupported strict model selection', async () => {
    const response = await request(downstream).post('/v1/messages')
      .send({ ...payload, model: 'claude-invented-model' });
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('invalid_request_error');
    expect(paths).toEqual(['/models']);
  });

  it('streams valid SSE and does not double count usage', async () => {
    complete = (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n');
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
      res.end('data: [DONE]\n\n');
    };
    const response = await request(downstream).post('/v1/messages')
      .send({ ...payload, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['x-proxy-actual-model']).toBe('claude-sonnet-5');
    expect(response.text).toContain('event: message_stop');
    expect(getUsage(session)).toMatchObject({ requestCount: 1, tokenCount: 7 });
  });

  it('enforces compatibility policy and reports intentional translation losses', async () => {
    const warned = await request(downstream).post('/v1/messages').send({
      ...payload,
      model: 'sonnet',
      thinking: { type: 'adaptive' },
    });
    expect(warned.status).toBe(200);
    expect(warned.headers['x-proxy-resolved-model']).toBe('claude-sonnet-5');
    expect(warned.headers['x-proxy-warnings']).toContain('model_resolved');
    expect(warned.headers['x-proxy-warnings']).toContain('thinking_unsupported');

    config.anthropic.unsupportedFeatures = 'reject';
    const rejected = await request(downstream).post('/v1/messages').send({
      ...payload,
      thinking: { type: 'adaptive' },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toContain('thinking_unsupported');
    expect(paths.filter(path => path === '/chat/completions')).toHaveLength(1);
  });

  it('labels token-count estimates and uses the resolved model', async () => {
    const response = await request(downstream).post('/v1/messages/count_tokens').send({
      model: 'sonnet',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(response.status).toBe(200);
    expect(response.body.input_tokens).toBeGreaterThan(0);
    expect(response.headers['x-proxy-resolved-model']).toBe('claude-sonnet-5');
    expect(response.headers['x-proxy-token-count']).toBe('heuristic');
  });

  it.each([false, true])('aborts an upstream request on client disconnect (stream=%s)', async stream => {
    let started!: () => void;
    let stopped!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { started = resolve; });
    const upstreamStopped = new Promise<void>(resolve => { stopped = resolve; });
    complete = (_req, res) => {
      res.on('close', stopped);
      started();
    };
    const client = http.request({
      hostname: '127.0.0.1',
      port: (downstream.address() as AddressInfo).port,
      path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    client.on('error', () => undefined);
    client.end(JSON.stringify({ ...payload, stream }));
    await upstreamStarted;
    client.destroy();
    await upstreamStopped;
    expect(paths).toEqual(['/models', '/chat/completions']);
    expect(getUsage(session)?.requestCount).toBe(1);
  });

  it('aborts a streaming body after the client receives its first event', async () => {
    let stopped!: () => void;
    const upstreamStopped = new Promise<void>(resolve => { stopped = resolve; });
    complete = (_req, res) => {
      res.on('close', stopped);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n');
    };
    const client = http.request({
      hostname: '127.0.0.1', port: (downstream.address() as AddressInfo).port,
      path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    client.on('error', () => undefined);
    client.on('response', res => res.once('data', () => client.destroy()));
    client.end(JSON.stringify({ ...payload, stream: true }));
    await upstreamStopped;
    expect(getUsage(session)?.requestCount).toBe(1);
  });
});
