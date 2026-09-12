import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { Response } from 'express';
import { abortOnDisconnect, writeResponse } from './response-stream.js';

function response() {
  return Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, write: jest.fn(() => false),
  });
}

describe('response stream lifecycle', () => {
  it('waits for drain and removes all temporary listeners', async () => {
    const res = response();
    const pending = writeResponse(res as unknown as Response, 'event');
    expect(res.listenerCount('drain')).toBe(1);
    res.emit('drain');
    expect(await pending).toBe(true);
    expect(res.eventNames()).toEqual([]);
  });

  it('does not hang if the client closes while waiting for drain', async () => {
    const res = response();
    const pending = writeResponse(res as unknown as Response, 'event');
    res.destroyed = true;
    res.emit('close');
    expect(await pending).toBe(false);
    expect(res.eventNames()).toEqual([]);
  });

  it('aborts upstream on disconnect but not normal response completion', () => {
    const res = response();
    const pending = abortOnDisconnect(res as unknown as Response);
    res.emit('close');
    expect(pending.signal.aborted).toBe(true);
    pending.cleanup();
    expect(res.eventNames()).toEqual([]);
    const completed = response();
    const normal = abortOnDisconnect(completed as unknown as Response);
    completed.writableEnded = true;
    completed.emit('close');
    expect(normal.signal.aborted).toBe(false);
    normal.cleanup();
  });
});
