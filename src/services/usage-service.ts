import { logger } from '../utils/logger.js';

// In-memory usage tracking
// Note: In a production environment with multiple instances,
// you might want to use Redis or a database for persistence
interface UsageMetrics {
  requestCount: number;
  tokenCount: number;
  lastRequestTime: number;
  startTime: number;
  // Track tokens used per minute window
  tokenTimestamps: Array<{
    tokens: number;
    timestamp: number;
  }>;
  // Timestamps of recent requests, used for the sliding-window rate limit
  requestTimestamps: number[];
}

interface ApiKeyUsage {
  [key: string]: UsageMetrics;
}

export const USAGE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_USAGE_SESSIONS = 1000;
const usage = new Map<string, UsageMetrics>();

function pruneSessions(): void {
  const cutoff = Date.now() - USAGE_SESSION_TTL_MS;
  for (const [id, metrics] of usage) {
    if (metrics.lastRequestTime > cutoff) {
      break;
    }
    usage.delete(id);
  }
}

function touchSession(sessionId: string, metrics: UsageMetrics): void {
  metrics.lastRequestTime = Date.now();
  usage.delete(sessionId);
  usage.set(sessionId, metrics);
}

function pruneWindows(metrics: UsageMetrics, now: number): void {
  metrics.tokenTimestamps = metrics.tokenTimestamps.filter(
    entry => entry.timestamp > now - 5 * 60 * 1000
  );
  metrics.requestTimestamps = metrics.requestTimestamps.filter(
    timestamp => timestamp > now - 60 * 1000
  );
}

/**
 * Initialize usage metrics for a session
 * @param sessionId Unique identifier for the session (typically a hashed token or IP)
 */
export function initializeUsage(sessionId: string): void {
  pruneSessions();
  if (!usage.has(sessionId)) {
    if (usage.size >= MAX_USAGE_SESSIONS) {
      usage.delete(usage.keys().next().value as string);
    }
    usage.set(sessionId, {
      requestCount: 0,
      tokenCount: 0,
      lastRequestTime: Date.now(),
      startTime: Date.now(),
      tokenTimestamps: [],
      requestTimestamps: []
    });
  }
}

/**
 * Track a request for usage metrics
 * @param sessionId Unique identifier for the session
 */
export function trackRequest(sessionId: string): void {
  initializeUsage(sessionId);
  const metrics = usage.get(sessionId)!;
  const now = Date.now();
  metrics.requestCount += 1;
  metrics.requestTimestamps.push(now);
  touchSession(sessionId, metrics);
  pruneWindows(metrics, now);
}

/** Record token usage without charging another request to the rate limit. */
export function trackTokens(sessionId: string, tokenCount: number): void {
  if (!Number.isFinite(tokenCount) || tokenCount <= 0) {
    return;
  }
  initializeUsage(sessionId);
  const metrics = usage.get(sessionId)!;
  const now = Date.now();
  metrics.tokenCount += tokenCount;
  const latest = metrics.tokenTimestamps[metrics.tokenTimestamps.length - 1];
  if (latest?.timestamp === now) {
    latest.tokens += tokenCount;
  } else {
    metrics.tokenTimestamps.push({ tokens: tokenCount, timestamp: now });
  }
  touchSession(sessionId, metrics);
  pruneWindows(metrics, now);
}

/**
 * Get usage metrics for a session
 * @param sessionId Unique identifier for the session
 * @returns Usage metrics or null if session not found
 */
export function getUsage(sessionId: string): UsageMetrics | null {
  pruneSessions();
  const metrics = usage.get(sessionId);
  if (metrics) {
    pruneWindows(metrics, Date.now());
  }
  return metrics || null;
}

/**
 * Get all usage metrics
 * @returns All usage metrics
 */
export function getAllUsage(): ApiKeyUsage {
  pruneSessions();
  return Object.fromEntries(usage);
}

/**
 * Get token usage for a specified time window
 * @param sessionId Unique identifier for the session
 * @param windowMs Time window in milliseconds
 * @returns Token count within the specified window
 */
export function getTokenUsageInWindow(sessionId: string, windowMs: number): number {
  const metrics = getUsage(sessionId);
  if (!metrics) {
    return 0;
  }
  
  const now = Date.now();
  const windowStart = now - windowMs;
  
  // Sum up tokens used within the window
  return metrics.tokenTimestamps
    .filter(entry => entry.timestamp > windowStart)
    .reduce((sum, entry) => sum + entry.tokens, 0);
}

/**
 * Check if a session has exceeded its request rate limit.
 *
 * Uses a sliding one-minute window over the recorded request timestamps. The
 * previous implementation compared the *cumulative* request count against the
 * limit, which permanently rate-limited any long-running Claude Code session.
 *
 * @param sessionId Unique identifier for the session
 * @param maxRequestsPerMinute Maximum requests allowed per minute (0 disables the limit)
 * @returns Whether rate limit is exceeded and retry-after time in seconds
 */
export function checkRateLimit(
  sessionId: string,
  maxRequestsPerMinute = 60
): { limited: boolean; retryAfter: number } {
  const metrics = getUsage(sessionId);
  if (!metrics || maxRequestsPerMinute <= 0) {
    return { limited: false, retryAfter: 0 };
  }

  const now = Date.now();
  const windowStart = now - 60 * 1000;

  const recent = metrics.requestTimestamps.filter(
    timestamp => timestamp > windowStart
  );
  metrics.requestTimestamps = recent;

  if (recent.length < maxRequestsPerMinute) {
    return { limited: false, retryAfter: 0 };
  }

  // The window frees up once the oldest request in it ages out.
  const oldest = recent[0];
  const retryAfter = Math.ceil((oldest + 60 * 1000 - now) / 1000);
  return { limited: true, retryAfter: Math.max(1, retryAfter) };
}

/**
 * Reset usage metrics for a session
 * @param sessionId Unique identifier for the session
 */
export function resetUsage(sessionId: string): void {
  if (usage.has(sessionId)) {
    usage.delete(sessionId);
    initializeUsage(sessionId);
    logger.info('Reset usage metrics for session');
  }
}

/**
 * Get usage summary with aggregated statistics
 * @returns Summary of usage statistics
 */
export function getUsageSummary(): {
  totalRequests: number;
  totalTokens: number;
  activeSessions: number;
  averageTokensPerRequest: number;
} {
  pruneSessions();
  const sessions = [...usage.values()];
  const totalRequests = sessions.reduce((sum, metrics) => sum + metrics.requestCount, 0);
  const totalTokens = sessions.reduce((sum, metrics) => sum + metrics.tokenCount, 0);
  
  return {
    totalRequests,
    totalTokens,
    activeSessions: sessions.length,
    averageTokensPerRequest: totalRequests > 0 ? totalTokens / totalRequests : 0
  };
}
