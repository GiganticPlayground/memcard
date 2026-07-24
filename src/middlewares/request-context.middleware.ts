import { randomUUID } from 'crypto';

import type { NextFunction, Request, Response } from 'express';
import { addLogContext, runLogContext } from 'logra';

import { logger } from '../utils/index';

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.header('x-request-id') ?? randomUUID();
  // Make the (possibly generated) id readable by downstream consumers such as
  // the reqcast analytics middleware, which reads it from the request headers.
  req.headers['x-request-id'] = requestId;
  const startedAt = Date.now();

  runLogContext(() => {
    addLogContext('requestId', requestId);
    addLogContext('method', req.method);
    addLogContext('path', req.path);
    addLogContext('ip', req.ip);

    res.setHeader('x-request-id', requestId);

    logger.info('START - INCOMING HTTP REQUEST');

    res.on('finish', () => {
      logger.info('END - INCOMING HTTP REQUEST', {
        durationMs: Date.now() - startedAt,
        statusCode: res.statusCode,
      });
    });

    next();
  });
}
