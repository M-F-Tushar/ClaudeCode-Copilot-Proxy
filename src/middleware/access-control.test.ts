import express from 'express';
import request from 'supertest';
import { app as serverApp } from '../server.js';
import { accessControl, assertSafeServerConfig, AccessControlOptions } from './access-control.js';
import { errorHandler } from './error-handler.js';

const options: AccessControlOptions = { host: 'localhost', port: 3000, allowedOrigins: [] };
const token = 'test-proxy-access-value';

function createApp(overrides: Partial<AccessControlOptions> = {}) {
  const app = express();
  app.use(accessControl({ ...options, ...overrides }));
  app.use(express.json({ limit: '1kb' }));
  app.all('*', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe('proxy access control', () => {
  it('allows local CLI requests without a configured token', async () => {
    const response = await request(createApp()).post('/v1/messages').send({});
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows same-origin browser requests on the listening port', async () => {
    const pending = request(createApp()).post('/auth/login');
    const origin = new URL(pending.url).origin;
    const response = await pending.set('Origin', origin).send({});
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['vary']).toContain('Origin');
  });

  it.each([
    'https://evil.example', 'null', 'http://localhost:1', 'http://127.0.0.1:1',
    'http://[::1]:1', 'http://localhost.evil.example:3000',
    ['http://localhost:3000', 'evil.example'].join('@'), 'http://localhost:3000/path',
    'http://localhost:3000 http://evil.example',
  ])('rejects malicious or wrong-port origin %s', async origin => {
    const response = await request(createApp()).post('/auth/logout').set('Origin', origin);
    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([
    'evil.example:3000', 'localhost.evil.example:3000', 'localhost:1',
    '127.0.0.1:1', 'localhost:3000@evil.example', 'localhost:3000,evil.example',
    'localhost:3000/path', 'localhost.:3000',
  ])('rejects untrusted Host %s even with a valid token', async host => {
    const response = await request(createApp({ authToken: token })).get('/auth/status')
      .set('Host', host).set('x-api-key', token);
    expect(response.status).toBe(403);
  });

  it('does not trust matching attacker Origin and Host or forwarded headers', async () => {
    const response = await request(createApp()).post('/auth/logout')
      .set('Host', 'evil.example').set('Origin', 'http://evil.example')
      .set('X-Forwarded-Host', 'localhost:3000').set('X-Forwarded-Proto', 'http');
    expect(response.status).toBe(403);
  });

  it.each(['cross-site', 'same-site'])('rejects originless %s browser requests', async site => {
    const response = await request(createApp()).get('/auth/status').set('Sec-Fetch-Site', site);
    expect(response.status).toBe(403);
  });

  it('does not allow cross-origin access without a configured token even if allowlisted', async () => {
    const response = await request(createApp({ allowedOrigins: ['https://ui.example'] }))
      .post('/auth/login').set('Origin', 'https://ui.example');
    expect(response.status).toBe(403);
  });

  it.each([
    '/v1/messages', '/v1/models', '/v1/messages/count_tokens',
    '/anthropic/v1/messages', '/anthropic/v1/models', '/anthropic/v1/messages/count_tokens',
    '/openai/v1/chat/completions', '/openai/v1/models',
    '/auth/status', '/auth/login', '/auth/check', '/auth/logout',
    '/usage/summary', '/usage/details', '/usage/reset-all', '/usage/reset/test',
    '/health/../auth/status', '/auth.html/../auth/status', '/health/anything', '/unknown',
  ])('requires the proxy token for %s', async path => {
    const app = express().use(accessControl({ ...options, authToken: token })).use(serverApp);
    const response = await request(app).post(path).send({});
    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Proxy authentication required');
  });

  it.each(['wrong', '', `${token}-extra`])('rejects invalid token %j', async value => {
    const response = await request(createApp({ authToken: token })).get('/auth/status')
      .set('x-api-key', value);
    expect(response.status).toBe(401);
  });

  it('rejects tokens in query parameters and cookies', async () => {
    const response = await request(createApp({ authToken: token }))
      .get(`/auth/status?api_key=${token}&token=${token}`).set('Cookie', `token=${token}`);
    expect(response.status).toBe(401);
  });

  it.each(['x-api-key', 'Authorization'])('accepts valid %s credentials', async header => {
    const response = await request(createApp({ authToken: token })).get('/auth/status')
      .set(header, header === 'Authorization' ? ['Bearer', token].join(' ') : token);
    expect(response.status).toBe(200);
  });

  it('allows either valid credential but rejects trailing authorization data', async () => {
    const app = createApp({ authToken: token });
    const response = await request(app).get('/auth/status')
      .set('Authorization', ['Bearer', token, 'extra'].join(' '));
    expect(response.status).toBe(401);
    const valid = await request(app).get('/auth/status')
      .set('Authorization', 'Basic invalid').set('x-api-key', token);
    expect(valid.status).toBe(200);
  });

  it('still requires the token for same-origin browser requests', async () => {
    const pending = request(createApp({ authToken: token })).post('/auth/login');
    expect((await pending.set('Origin', new URL(pending.url).origin)).status).toBe(401);
  });

  it('allows configured external origins and their advertised Host only with authentication', async () => {
    const app = createApp({ host: '0.0.0.0', authToken: token, allowedOrigins: ['https://proxy.example'] });
    const response = await request(app).get('/auth/status')
      .set('Host', 'proxy.example').set('Origin', 'https://proxy.example').set('x-api-key', token);
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://proxy.example');
    expect((await request(app).get('/auth/status').set('Host', 'proxy.example')).status).toBe(401);
  });

  it('allows the explicitly configured non-loopback bind hostname', async () => {
    const pending = request(createApp({ host: 'proxy.example', authToken: token })).get('/auth/status');
    const authority = `proxy.example:${new URL(pending.url).port}`;
    const response = await pending.set('Host', authority).set('Origin', `http://${authority}`)
      .set('x-api-key', token);
    expect(response.status).toBe(200);
  });

  it('handles trusted preflights without credentials but never executes the route', async () => {
    const pending = request(createApp({ authToken: token })).options('/auth/login');
    const response = await pending.set('Origin', new URL(pending.url).origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-api-key');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
    expect(response.body).toEqual({});
  });

  it('rejects an untrusted preflight', async () => {
    const response = await request(createApp()).options('/auth/login')
      .set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(response.status).toBe(403);
  });

  it('rejects unsupported preflight headers', async () => {
    const pending = request(createApp()).options('/auth/login');
    const response = await pending.set('Origin', new URL(pending.url).origin)
      .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'x-evil');
    expect(response.status).toBe(403);
  });

  it.each(['/health', '/auth.html', '/usage.html'])('serves only public GET/HEAD %s without the token', async path => {
    const app = express().use(accessControl({ ...options, authToken: token })).use(serverApp);
    const response = await request(app).get(path);
    expect(response.status).toBe(200);
    if (path === '/health') expect(response.body).toMatchObject({ status: 'healthy' });
    else expect(response.text).toContain('proxy-token-form');
    expect((await request(app).head(path)).status).toBe(200);
    expect((await request(app).post(path)).status).toBe(401);
  });

  it('authenticates before parsing untrusted request bodies', async () => {
    const response = await request(createApp({ authToken: token })).post('/v1/messages')
      .set('Content-Type', 'application/json').send('{"invalid"');
    expect(response.status).toBe(401);
  });

  it('enforces the configured body limit after authentication', async () => {
    const response = await request(createApp({ authToken: token })).post('/v1/messages')
      .set('x-api-key', token).send({ content: 'x'.repeat(2048) });
    expect(response.status).toBe(413);
    expect(response.body.error.message).toBe('Request body too large');
  });
});

describe('safe server binding', () => {
  it.each(['localhost', '127.0.0.1', '127.0.1.1', '::1', '[::1]'])('allows loopback %s without a token', host => {
    expect(() => assertSafeServerConfig({ ...options, host })).not.toThrow();
  });

  it.each(['0.0.0.0', '::', '[::]', '192.168.1.2', 'proxy.example', 'localhost.evil.example'])(
    'requires a token for non-loopback %s', host => {
      expect(() => assertSafeServerConfig({ ...options, host })).toThrow('PROXY_AUTH_TOKEN');
      expect(() => assertSafeServerConfig({ ...options, host, authToken: '  ' })).toThrow('PROXY_AUTH_TOKEN');
      expect(() => assertSafeServerConfig({ ...options, host, authToken: token })).not.toThrow();
    });

  it.each(['*', 'https://*.example', 'null', 'file:///example', ['http://user:pass', 'example.com'].join('@')])(
    'rejects invalid allowed origin %s', origin => {
      expect(() => assertSafeServerConfig({ ...options, allowedOrigins: [origin] }))
        .toThrow('PROXY_ALLOWED_ORIGINS');
    });
});
