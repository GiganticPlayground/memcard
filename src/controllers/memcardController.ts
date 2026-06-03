import type { NextFunction, Request, Response } from 'express';

import { memcardService } from '../services';
import { HttpError } from '../utils/index';

function requireAuth(req: Request): { app: string; userId: string } {
  if (!req.auth) {
    // Should never happen — authMiddleware runs first — but keep the type safe.
    throw new HttpError(401, 'Unauthenticated');
  }
  return req.auth;
}

/**
 * Fetch the authenticated player's state.
 * @route GET /v1/memcard/me/state
 */
export const getMemcardState = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { app, userId } = requireAuth(req);
    const ifNoneMatch = req.header('if-none-match');

    const result = await memcardService.fetch(app, userId, ifNoneMatch);

    res.setHeader('ETag', result.etag);
    if (result.status === 304) {
      res.status(304).end();
      return;
    }

    res.status(200).json(result.body);
  } catch (error) {
    next(error);
  }
};

/**
 * Save the authenticated player's state using optimistic concurrency control.
 * @route PUT /v1/memcard/me/state
 */
export const putMemcardState = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { app, userId } = requireAuth(req);

    const ifMatch = req.header('if-match');
    if (!ifMatch) {
      throw new HttpError(400, 'If-Match header is required');
    }

    const body = req.body as { state?: Record<string, unknown> };
    if (!body || typeof body.state !== 'object' || body.state === null) {
      throw new HttpError(400, 'Request body must contain a "state" object');
    }

    const result = await memcardService.save(app, userId, ifMatch, body.state);

    res.setHeader('ETag', result.etag);
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};
