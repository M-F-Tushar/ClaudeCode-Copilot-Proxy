import request from 'supertest';
import { app } from '../server.js';

describe('Anthropic routes', () => {
  describe('when GitHub Copilot is not authenticated', () => {
    it('rejects /v1/messages with an Anthropic-shaped error', async () => {
      const response = await request(app)
        .post('/v1/messages')
        .send({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [] });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: expect.stringContaining('GitHub Copilot authentication required'),
        },
      });
    });

    it('rejects /v1/models the same way', async () => {
      const response = await request(app).get('/v1/models');

      expect(response.status).toBe(401);
      expect(response.body.error.type).toBe('authentication_error');
    });

    it('serves the health endpoint without authentication', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
    });
  });

  describe('routing', () => {
    it('exposes the Anthropic API at both /v1 and /anthropic/v1', async () => {
      const [mounted, aliased] = await Promise.all([
        request(app).get('/v1/models'),
        request(app).get('/anthropic/v1/models'),
      ]);

      expect(mounted.status).toBe(aliased.status);
    });

    it('returns 404 for unknown paths', async () => {
      const response = await request(app).get('/does-not-exist');

      expect(response.status).toBe(404);
    });
  });
});
