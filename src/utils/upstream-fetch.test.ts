import { jest } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { config } from '../config/index.js';
import { destroyUpstreamBody, upstreamFetch, UpstreamTimeoutError } from './upstream-fetch.js';

describe('upstreamFetch', () => {
  const original = { ...config.upstream };
  let handler: http.RequestListener;
  let calls = 0;
  let url: string;
  const server = http.createServer((req, res) => {
    calls++;
    res.setHeader('Connection', 'close');
    handler(req, res);
  });

  beforeEach(async () => {
    calls = 0;
    Object.assign(config.upstream, { timeoutMs: 150, maxRetries: 0, maxRetryDelayMs: 50 });
    handler = (_req, res) => res.end('ok');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    Object.assign(config.upstream, original);
    jest.restoreAllMocks();
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())
    );
  });

  it('does not retry even explicit transient failures by default', async () => {
    handler = (_req, res) => { res.writeHead(503); res.end('unavailable'); };
    const response = await upstreamFetch(url, { method: 'POST', body: 'prompt' });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('unavailable');
    expect(calls).toBe(1);
  });

  it.each([429, 502, 503, 504])('retries an explicit %i when opted in', async status => {
    config.upstream.maxRetries = 1;
    handler = (_req, res) => {
      res.writeHead(calls === 1 ? status : 200, { 'Retry-After': '0' });
      res.end('ok');
    };
    const response = await upstreamFetch(url, { method: 'POST', body: 'prompt' });
    expect(await response.text()).toBe('ok');
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('allows safe callers to retry without enabling generation retries globally', async () => {
    handler = (_req, res) => {
      res.writeHead(calls === 1 ? 503 : 200, { 'Retry-After': '0' });
      res.end('ok');
    };
    const response = await upstreamFetch(url, {}, { maxRetries: 1 });
    expect(await response.text()).toBe('ok');
    expect(calls).toBe(2);
    expect(config.upstream.maxRetries).toBe(0);
  });

  it('respects Retry-After without retrying earlier than the delay cap allows', async () => {
    config.upstream.maxRetries = 2;
    handler = (_req, res) => { res.writeHead(429, { 'Retry-After': '60' }); res.end(); };
    const response = await upstreamFetch(url);
    expect(response.status).toBe(429);
    await response.text();
    expect(calls).toBe(1);
  });

  it('caps attempts and does not retry non-transient status codes', async () => {
    config.upstream.maxRetries = 2;
    handler = (_req, res) => { res.writeHead(400, { 'Retry-After': '0' }); res.end(); };
    const badRequest = await upstreamFetch(url);
    await badRequest.text();
    expect(calls).toBe(1);
    calls = 0;
    handler = (_req, res) => { res.writeHead(503, { 'Retry-After': '0' }); res.end(); };
    const exhausted = await upstreamFetch(url);
    await exhausted.text();
    expect(exhausted.status).toBe(503);
    expect(calls).toBe(3);
  });

  it('does not replay ambiguous network failures or one-shot request bodies', async () => {
    config.upstream.maxRetries = 2;
    handler = req => req.socket.destroy();
    await expect(upstreamFetch(url, { method: 'POST', body: 'prompt' })).rejects.toThrow();
    expect(calls).toBe(1);
    calls = 0;
    handler = (_req, res) => { res.writeHead(503, { 'Retry-After': '0' }); res.end(); };
    const response = await upstreamFetch(url, { method: 'POST', body: Readable.from(['prompt']) });
    await response.text();
    expect(calls).toBe(1);
  });

  it('times out while waiting for headers without replaying', async () => {
    config.upstream.maxRetries = 2;
    handler = () => undefined;
    await expect(upstreamFetch(url)).rejects.toBeInstanceOf(UpstreamTimeoutError);
    expect(calls).toBe(1);
  });

  it('keeps the deadline active while consuming a stalled response body', async () => {
    handler = (_req, res) => { res.writeHead(200); res.write('partial'); };
    const response = await upstreamFetch(url);
    await expect(response.text()).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('does not start the response body flowing before its caller reads it', async () => {
    handler = (_req, res) => res.end('complete payload');
    const response = await upstreamFetch(url);
    expect((response.body as Readable).readableFlowing).not.toBe(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await response.text()).toBe('complete payload');
  });

  it('propagates cancellation before headers and during a body', async () => {
    handler = () => undefined;
    const beforeHeaders = new AbortController();
    const pending = upstreamFetch(url, { signal: beforeHeaders.signal });
    beforeHeaders.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    handler = (_req, res) => { res.writeHead(200); res.write('partial'); };
    const duringBody = new AbortController();
    const response = await upstreamFetch(url, { signal: duringBody.signal });
    const text = response.text();
    duringBody.abort();
    await expect(text).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cleans up abort listeners after a body is consumed or discarded', async () => {
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const response = await upstreamFetch(url, { signal: controller.signal });
    await response.text();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    remove.mockClear();
    const discarded = await upstreamFetch(url, { signal: controller.signal });
    destroyUpstreamBody(discarded);
    await new Promise(resolve => setImmediate(resolve));
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('cancels a Retry-After wait without another request', async () => {
    config.upstream.maxRetries = 2;
    config.upstream.maxRetryDelayMs = 1000;
    config.upstream.timeoutMs = 2000;
    const controller = new AbortController();
    handler = (_req, res) => {
      res.writeHead(503, { 'Retry-After': '1' });
      res.end();
      setTimeout(() => controller.abort(), 20);
    };
    await expect(upstreamFetch(url, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });
});
