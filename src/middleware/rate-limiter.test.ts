import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { config } from '../config/index.js';
import { resetUsage, trackRequest, trackTokens } from '../services/usage-service.js';
import { rateLimiter } from './rate-limiter.js';

describe('rate limiter accounting', () => {
  const session = createHash('sha256').update('test-session').digest('hex');
  const originalTokens = config.rateLimits.maxTokensPerMinute;
  beforeEach(() => {
    resetUsage(session);
    config.rateLimits.maxTokensPerMinute = 0;
  });
  afterEach(() => { config.rateLimits.maxTokensPerMinute = originalTokens; });

  function app(limit: number) {
    const application = express();
    application.use(express.json());
    application.use((_req, res, next) => { res.locals.token = 'test-session'; next(); });
    application.use(rateLimiter({ maxRequestsPerMinute: limit, format: 'anthropic' }));
    application.post('/messages', (_req, res) => {
      trackRequest(res.locals.sessionId);
      trackTokens(res.locals.sessionId, 10);
      res.json({ ok: true });
    });
    return application;
  }

  it('allows the configured number of completions regardless of token updates', async () => {
    const application = app(2);
    expect((await request(application).post('/messages').send({})).status).toBe(200);
    expect((await request(application).post('/messages').send({})).status).toBe(200);
    const limited = await request(application).post('/messages').send({});
    expect(limited.status).toBe(429);
    expect(limited.body.error.type).toBe('rate_limit_error');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('honors an explicit zero override and enforces a reached token ceiling', async () => {
    for (let index = 0; index < 1000; index++) {
      trackRequest(session);
    }
    const application = app(0);
    expect((await request(application).post('/messages').send({})).status).toBe(200);
    config.rateLimits.maxTokensPerMinute = 10;
    expect((await request(application).post('/messages').send({})).status).toBe(429);
  });
});
