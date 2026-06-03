import type { Server } from 'http';

import { logger } from './logger';

export function setupShutdown(server: Server, timeoutMs: number): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn('Shutdown already in progress — ignoring signal', { signal });
      return;
    }
    shuttingDown = true;

    logger.info('Shutdown initiated', { signal, timeoutMs });

    const forceExit = setTimeout(() => {
      logger.warn('Shutdown timeout exceeded — forcing exit', { timeoutMs });
      process.exit(1);
    }, timeoutMs).unref();

    logger.info('Closing HTTP server — stopping new connections');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.info('HTTP server closed');

    clearTimeout(forceExit);
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
