import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

/**
 * Middleware to log HTTP requests
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const { method } = req;
  
  // Log request start
  logger.debug(`${method} - Request received`);
  
  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const { statusCode } = res;
    
    // Log based on status code
    if (statusCode >= 500) {
      logger.error(`${method} - ${statusCode} - ${duration}ms`);
    } else if (statusCode >= 400) {
      logger.warn(`${method} - ${statusCode} - ${duration}ms`);
    } else {
      logger.info(`${method} - ${statusCode} - ${duration}ms`);
    }
  });
  
  next();
}
