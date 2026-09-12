import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export interface AppError extends Error {
  status?: number;
  code?: string;
}

/**
 * Global error handler middleware for Express
 */
export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const status = Number.isInteger(err.status) && err.status! >= 400 && err.status! <= 599
    ? err.status! : 500;
  const errors: Record<number, [string, string]> = {
    400: ['Bad Request', 'BAD_REQUEST'],
    401: ['Authentication required', 'UNAUTHORIZED'],
    403: ['Forbidden', 'FORBIDDEN'],
    404: ['Not Found', 'NOT_FOUND'],
    413: ['Request body too large', 'PAYLOAD_TOO_LARGE'],
    429: ['Too Many Requests', 'RATE_LIMITED'],
    502: ['Upstream request failed', 'BAD_GATEWAY'],
    503: ['Service Unavailable', 'SERVICE_UNAVAILABLE'],
    504: ['Upstream request timed out', 'GATEWAY_TIMEOUT'],
  };
  const [message, code] = errors[status] ?? ['Internal Server Error', 'INTERNAL_ERROR'];
  // Error messages and stacks can contain upstream bodies, credentials, or JSON parse input.
  logger.error(`${status} - ${req.method} - Request failed`);
  if (res.headersSent) {
    res.destroy();
    return;
  }

  // Send response to client
  res.status(status).json({
    error: {
      message,
      code,
      status,
    }
  });
}
