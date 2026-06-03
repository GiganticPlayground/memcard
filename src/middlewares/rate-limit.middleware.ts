import { rateLimit } from 'express-rate-limit';

import { config } from '../config/index';

export const authRateLimitMiddleware = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  limit: config.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many requests. Try again later.',
    code: 'RATE_LIMITED',
  },
});
