import { app } from './server.js';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { loadPersistedTokens } from './services/auth-service.js';
import { primeModelCatalog } from './services/model-catalog.js';
import { assertSafeServerConfig } from './middleware/access-control.js';

const startServer = () => {
  const port = config.server.port;
  const host = config.server.host;

  try {
    assertSafeServerConfig(config.server);
    // Load persisted tokens on startup
    loadPersistedTokens();
    // Warm the model list so the first /v1/models call is already accurate
    primeModelCatalog();
    app.listen(port, host, () => {
      logger.info(`Server running at http://${host}:${port}/`);
      logger.info('Press CTRL-C to stop the server');
    }).on('error', () => {
      logger.error('Unable to bind the proxy listener');
      process.exit(1);
    });
  } catch {
    logger.error('Error starting server; check the bind address and proxy configuration');
    process.exit(1);
  }
};

// Handle graceful shutdown
const shutdown = () => {
  logger.info('Shutting down server...');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', () => {
  logger.error('Uncaught exception');
  process.exit(1);
});

// Start server
startServer();
