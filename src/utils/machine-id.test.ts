import { jest } from '@jest/globals';
import * as os from 'node:os';

const interfaces = jest.fn(() => ({}));
jest.unstable_mockModule('os', () => ({ ...os, networkInterfaces: interfaces }));
const { getMachineId } = await import('./machine-id.js');

it('caches the fallback machine ID instead of generating a new identity per request', () => {
  const first = getMachineId();
  expect(first).toMatch(/^[\da-f-]+$/);
  expect(getMachineId()).toBe(first);
  expect(interfaces).toHaveBeenCalledTimes(1);
});
