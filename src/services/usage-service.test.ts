import { jest } from '@jest/globals';
import {
  checkRateLimit, getAllUsage, getTokenUsageInWindow, getUsage, getUsageSummary,
  initializeUsage, MAX_USAGE_SESSIONS, resetUsage, trackRequest, trackTokens, USAGE_SESSION_TTL_MS,
} from './usage-service.js';

describe('usage accounting', () => {
  let now = Date.now();
  beforeEach(() => {
    now += USAGE_SESSION_TTL_MS + 1;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    getAllUsage();
  });
  afterEach(() => jest.restoreAllMocks());

  it('counts one buffered completion once while adding its tokens separately', () => {
    trackRequest('buffered');
    trackTokens('buffered', 30);
    expect(getUsage('buffered')).toMatchObject({ requestCount: 1, tokenCount: 30 });
    expect(checkRateLimit('buffered', 2).limited).toBe(false);
  });

  it('does not charge streaming chunks as additional requests', () => {
    trackRequest('stream');
    for (let index = 0; index < 100; index++) {
      trackTokens('stream', 2);
    }
    expect(getUsage('stream')).toMatchObject({ requestCount: 1, tokenCount: 200 });
    expect(getTokenUsageInWindow('stream', 60000)).toBe(200);
    expect(getUsageSummary()).toMatchObject({
      totalRequests: 1, totalTokens: 200, averageTokensPerRequest: 200,
    });
  });

  it('expires rate-limit windows at their boundary without resetting lifetime totals', () => {
    trackRequest('window');
    trackTokens('window', 12);
    expect(checkRateLimit('window', 1)).toEqual({ limited: true, retryAfter: 60 });
    now += 60000;
    expect(checkRateLimit('window', 1)).toEqual({ limited: false, retryAfter: 0 });
    expect(getTokenUsageInWindow('window', 60000)).toBe(0);
    expect(getUsage('window')).toMatchObject({ requestCount: 1, tokenCount: 12 });
  });

  it('expires idle sessions even when only reading usage', () => {
    trackRequest('expired');
    now += USAGE_SESSION_TTL_MS;
    expect(getUsage('expired')).toBeNull();
    expect(getUsageSummary().activeSessions).toBe(0);
  });

  it('bounds session count and evicts the least recently active session', () => {
    for (let index = 0; index < MAX_USAGE_SESSIONS; index++) {
      trackRequest(`session-${index}`);
    }
    trackTokens('session-0', 1);
    trackRequest('new-session');
    expect(getUsage('session-0')).not.toBeNull();
    expect(getUsage('session-1')).toBeNull();
    expect(Object.keys(getAllUsage())).toHaveLength(MAX_USAGE_SESSIONS);
  });

  it('safely handles special session keys and invalid token increments', () => {
    initializeUsage('__proto__');
    trackRequest('__proto__');
    for (const value of [NaN, Infinity, -1, 0]) {
      trackTokens('__proto__', value);
    }
    expect(getUsage('__proto__')).toMatchObject({ requestCount: 1, tokenCount: 0 });
    expect(checkRateLimit('__proto__', 0).limited).toBe(false);
    resetUsage('__proto__');
    expect(getUsage('__proto__')).toMatchObject({ requestCount: 0, tokenCount: 0 });
  });
});
