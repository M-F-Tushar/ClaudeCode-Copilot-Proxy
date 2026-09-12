import { jest } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CopilotToken } from '../types/github.js';

let token: CopilotToken | null = null;
jest.unstable_mockModule('./auth-service.js', () => ({
  getCopilotToken: () => token,
}));
const { getCatalogSnapshot, refreshModelCatalog, setCatalogForTesting } =
  await import('./model-catalog.js');

describe('model catalog refresh', () => {
  let server: http.Server;
  let calls = 0;
  let release: (() => void) | undefined;
  let status = 200;

  beforeEach(async () => {
    calls = 0;
    status = 200;
    release = undefined;
    server = http.createServer((_req, res) => {
      calls++;
      res.setHeader('Connection', 'close');
      const respond = () => {
        res.writeHead(status);
        res.end(JSON.stringify({ data: [{ id: `model-${calls}`, vendor: 'Anthropic', capabilities: { type: 'chat' } }] }));
      };
      if (release === undefined) respond();
      else {
        const pending = release;
        release = () => { pending(); respond(); };
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    token = {
      token: 'test-only-token', expires_at: Date.now() / 1000 + 3600, refresh_in: 300,
      chat_enabled: true, sku: 'test', telemetry: '', tracking_id: '',
      endpoints: { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    };
    setCatalogForTesting([]);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setCatalogForTesting([]);
  });

  const stale = () => setCatalogForTesting([{
    id: 'stale-model', displayName: 'Stale', vendor: 'Anthropic', isClaude: true, pickerEnabled: true,
    isChatDefault: false, supportsTools: true, supportsVision: true,
  }], 11 * 60 * 1000);

  it('waits for the catalog only on a cold start', async () => {
    const models = await refreshModelCatalog();
    expect(models.map((model) => model.id)).toEqual(['model-1']);
    expect(calls).toBe(1);
    expect((await refreshModelCatalog()).map((model) => model.id)).toEqual(['model-1']);
    expect(calls).toBe(1);
  });

  it('serves a stale snapshot immediately while one background refresh replaces it', async () => {
    stale();
    release = () => undefined;
    const first = refreshModelCatalog();
    const second = refreshModelCatalog();
    expect((await first).map((model) => model.id)).toEqual(['stale-model']);
    expect((await second).map((model) => model.id)).toEqual(['stale-model']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getCatalogSnapshot().map((model) => model.id)).toEqual(['model-1']);
  });

  it('keeps the previous snapshot and backs off after a failed refresh', async () => {
    stale();
    status = 503;
    await refreshModelCatalog();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getCatalogSnapshot().map((model) => model.id)).toEqual(['stale-model']);
    await refreshModelCatalog();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    status = 200;
    expect((await refreshModelCatalog({ force: true })).map((model) => model.id)).toEqual(['model-2']);
    expect(calls).toBe(2);
  });

  it('does not attempt a fetch or start a backoff without credentials', async () => {
    token = null;
    expect(await refreshModelCatalog()).toEqual([]);
    expect(calls).toBe(0);
    token = {
      token: 'test-only-token', expires_at: Date.now() / 1000 + 3600, refresh_in: 300,
      chat_enabled: true, sku: 'test', telemetry: '', tracking_id: '',
      endpoints: { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    };
    expect((await refreshModelCatalog()).map((model) => model.id)).toEqual(['model-1']);
  });
});
