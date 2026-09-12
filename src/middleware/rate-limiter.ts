import { Request, Response, NextFunction } from 'express';
import { checkRateLimit, getUsage, getTokenUsageInWindow } from '../services/usage-service.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import crypto from 'crypto';

// Route-specific rate limits. Paths are relative to the router mount point,
// so both the Anthropic (`/messages`) and OpenAI (`/chat/completions`)
// completion endpoints are covered.
const ROUTE_RATE_LIMITS: Record<string, number> = {
  '/messages': config.rateLimits.chatCompletions,
  '/chat/completions': config.rateLimits.chatCompletions,
};

// Routes whose payload size should be checked against the token ceilings
const COMPLETION_ROUTES = new Set(Object.keys(ROUTE_RATE_LIMITS));

/** Error body shape to emit when a limit is hit. */
export type RateLimitErrorFormat = 'openai' | 'anthropic';

export interface RateLimiterOptions {
  /** Override for max requests per minute */
  maxRequestsPerMinute?: number;
  /** Error envelope expected by the client (Claude Code needs 'anthropic') */
  format?: RateLimitErrorFormat;
}

/**
 * Build a rate-limit error body in the format the calling client expects.
 */
function buildErrorBody(
  format: RateLimitErrorFormat,
  type: string,
  message: string
): Record<string, unknown> {
  if (format === 'anthropic') {
    return { type: 'error', error: { type: 'rate_limit_error', message } };
  }

  return { error: { message, type, code: 429 } };
}

/**
 * Middleware to implement rate limiting
 * @param options Limit override and error format, or a plain requests-per-minute number
 * @returns Express middleware function
 */
export function rateLimiter(options: RateLimiterOptions | number = {}) {
  const { maxRequestsPerMinute, format = 'openai' } =
    typeof options === 'number' ? { maxRequestsPerMinute: options, format: 'openai' as const } : options;

  return function(req: Request, res: Response, next: NextFunction) {
    // Determine rate limit based on route
    const route = req.path;
    const routeLimit = ROUTE_RATE_LIMITS[route];
    const effectiveLimit = maxRequestsPerMinute ?? routeLimit ?? config.rateLimits.default;

    // Get session identifier - use token hash if available, or IP address
    const token = res.locals.token || '';
    const ipAddress = req.ip || req.socket.remoteAddress || '';
    const sessionId = token
      ? crypto.createHash('sha256').update(token).digest('hex')
      : crypto.createHash('sha256').update(ipAddress).digest('hex');

    // Check request-based rate limit
    const { limited, retryAfter } = checkRateLimit(sessionId, effectiveLimit);

    if (limited) {
      logger.warn(`Rate limit exceeded for session: ${sessionId.substring(0, 8)}...`);
      
      res.setHeader('Retry-After', retryAfter.toString());
      res.status(429).json(
        buildErrorBody(
          format,
          'rate_limit_exceeded',
          `Rate limit exceeded. Try again in ${retryAfter} seconds.`
        )
      );
      return;
    }

    // Check token-based rate limits on completion requests. Both ceilings
    // default to 0 (disabled) because Claude Code legitimately sends very
    // large contexts; operators can opt in via MAX_TOKENS_PER_* env vars.
    if (COMPLETION_ROUTES.has(route)) {
      const usage = getUsage(sessionId);
      
      // If we have usage data, check token limits
      if (usage && config.rateLimits.maxTokensPerMinute > 0) {
        // Get token usage for the past minute
        const tokensPastMinute = getTokenUsageInWindow(sessionId, 60 * 1000);
        
        if (tokensPastMinute >= config.rateLimits.maxTokensPerMinute) {
          logger.warn(`Token rate limit exceeded for session: ${sessionId.substring(0, 8)}...`);
          
          // Calculate when they can try again based on token usage
          const tokenRetryAfter = 60; // Default to 1 minute
          
          res.setHeader('Retry-After', tokenRetryAfter.toString());
          res.status(429).json(
            buildErrorBody(
              format,
              'token_rate_limit_exceeded',
              `Token usage rate limit exceeded. Try again in ${tokenRetryAfter} seconds.`
            )
          );
          return;
        }
        
      }

      // Check if this particular request might exceed per-request token limits
      // This is a rough estimate based on request body size
      if (config.rateLimits.maxTokensPerRequest > 0) {
        const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
        if (messages.length > 0) {
          const estimatedTokens = messages.reduce((total: number, msg: { content?: unknown }) => {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
            // Rough estimate: 1 token ≈ 4 chars
            return total + Math.ceil(content.length / 4);
          }, 0);
          
          if (estimatedTokens > config.rateLimits.maxTokensPerRequest) {
            logger.warn(`Request exceeds max tokens (est. ${estimatedTokens}) for session: ${sessionId.substring(0, 8)}...`);
            
            res.status(429).json(
              buildErrorBody(
                format,
                'max_tokens_exceeded',
                'Request exceeds maximum token limit. Please reduce the size of your messages.'
              )
            );
            return;
          }
        }
      }
    }

    // Store session ID for usage tracking in route handlers
    res.locals.sessionId = sessionId;
    next();
  };
}
