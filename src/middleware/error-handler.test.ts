import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { logger } from '../utils/logger.js';
import { errorHandler, AppError } from './error-handler.js';
import { requestLogger } from './request-logger.js';

afterEach(() => jest.restoreAllMocks());

describe('safe request diagnostics', () => {
  it('does not expose request bodies, credentials, queries, errors, or stacks', async () => {
    const errorLog = jest.spyOn(logger, 'error');
    const debugLog = jest.spyOn(logger, 'debug');
    const app = express();
    app.use(requestLogger);
    app.use(express.json());
    app.post('/error/:privateValue', (_req, _res, next) => {
      const error: AppError = new Error('upstream-secret in an error');
      error.code = 'secret-error-code';
      next(error);
    });
    app.use(errorHandler);
    const response = await request(app).post('/error/private-path?api_key=query-secret')
      .set('x-api-key', 'header-secret').send({ prompt: 'body-secret' });
    expect(response.status).toBe(500);
    const output = JSON.stringify([response.body, errorLog.mock.calls, debugLog.mock.calls]);
    for (const secret of ['upstream-secret', 'secret-error-code', 'private-path', 'query-secret', 'header-secret', 'body-secret']) {
      expect(output).not.toContain(secret);
    }
    expect(response.body.error.message).toBe('Internal Server Error');
  });

  it('does not echo malformed JSON input in parse errors', async () => {
    const errorLog = jest.spyOn(logger, 'error');
    const app = express().use(express.json()).use(errorHandler);
    const response = await request(app).post('/').set('Content-Type', 'application/json')
      .send('{"private":"request-secret", invalid}');
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Bad Request');
    expect(JSON.stringify([response.body, errorLog.mock.calls])).not.toContain('request-secret');
  });

  it('omits sensitive URL data from successful request logs too', async () => {
    const infoLog = jest.spyOn(logger, 'info');
    const app = express().use(requestLogger).get('*', (_req, res) => res.sendStatus(200));
    await request(app).get('/private-path?token=query-secret');
    const output = JSON.stringify(infoLog.mock.calls);
    expect(output).not.toContain('query-secret');
    expect(output).not.toContain('private-path');
  });
});
