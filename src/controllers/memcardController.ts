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
 * Resolve the target of an admin request from the URL.
 *
 * The auth middleware already refuses a non-admin credential on these paths;
 * re-checking here means the privilege is enforced next to the code that acts on
 * it, so a future routing change cannot quietly expose them.
 */
function requireAdminTarget(req: Request): { app: string; userId: string } {
  if (!req.authStrategy?.admin) {
    throw new HttpError(403, 'This credential is not allowed on the admin routes');
  }

  const app = req.params['app'];
  const userId = req.params['userId'];
  if (typeof app !== 'string' || !app || typeof userId !== 'string' || !userId) {
    // The spec marks both as required single values, so the validator rejects
    // this first; the check keeps the S3 key builder fed with real strings.
    throw new HttpError(400, 'Both {app} and {userId} path parameters are required');
  }

  return { app, userId };
}

/** Conditional read of one player's state. Identical for both route families. */
async function fetchState(
  req: Request,
  res: Response,
  target: { app: string; userId: string },
): Promise<void> {
  const ifNoneMatch = req.header('if-none-match');

  const result = await memcardService.fetch(target.app, target.userId, ifNoneMatch);

  res.setHeader('ETag', result.etag);
  if (result.status === 304) {
    res.status(304).end();
    return;
  }

  res.status(200).json(result.body);
}

/** Conditional write of one player's state. Identical for both route families. */
async function saveState(
  req: Request,
  res: Response,
  target: { app: string; userId: string },
): Promise<void> {
  const ifMatch = req.header('if-match');
  if (!ifMatch) {
    throw new HttpError(400, 'If-Match header is required');
  }

  const body = req.body as { state?: Record<string, unknown> };
  if (!body || typeof body.state !== 'object' || body.state === null) {
    throw new HttpError(400, 'Request body must contain a "state" object');
  }

  const result = await memcardService.save(target.app, target.userId, ifMatch, body.state);

  res.setHeader('ETag', result.etag);
  res.status(200).json({ success: true });
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
    await fetchState(req, res, requireAuth(req));
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
    await saveState(req, res, requireAuth(req));
  } catch (error) {
    next(error);
  }
};

/**
 * Fetch a named player's state on behalf of an internal service.
 * @route GET /v1/memcard/admin/{app}/{userId}/state
 */
export const getPlayerState = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await fetchState(req, res, requireAdminTarget(req));
  } catch (error) {
    next(error);
  }
};

/**
 * Save a named player's state on behalf of an internal service.
 * @route PUT /v1/memcard/admin/{app}/{userId}/state
 */
export const putPlayerState = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await saveState(req, res, requireAdminTarget(req));
  } catch (error) {
    next(error);
  }
};
