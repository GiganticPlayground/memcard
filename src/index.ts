import { readFileSync } from 'fs';
import { join } from 'path';

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

import { config } from './config/index';
import {
  authMiddleware,
  authRateLimitMiddleware,
  createOpenApiValidatorMiddleware,
  errorHandlerMiddleware,
  requestContextMiddleware,
} from './middlewares/index';
import { buildStateKey } from './services/memcard.service';
import { buildAnalytics, logger } from './utils/index';
import { setupShutdown } from './utils/shutdown';

// Load OpenAPI specification
export const apiSpecPath: string = join(process.cwd(), 'api/openapi.yaml');
const apiSpecContent: string = readFileSync(apiSpecPath, 'utf8');
const apiSpec: swaggerUi.JsonObject = YAML.parse(apiSpecContent) as swaggerUi.JsonObject;

const app = express();
app.set('trust proxy', config.TRUST_PROXY);

const corsOptions =
  !config.CORS_ORIGINS || config.CORS_ORIGINS === '*'
    ? undefined
    : {
        origin: config.CORS_ORIGINS,
      };

// Security and body parsing middleware
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: config.MEMCARD_MAX_BODY_BYTES }));
app.use(express.urlencoded({ extended: true }));
app.use(requestContextMiddleware);

// Request/response analytics — opt-in, enabled only when a reqcast config is present.
const analytics = buildAnalytics();
if (analytics?.enabled) {
  app.use(analytics.middleware);
  logger.info('request analytics enabled');
}

if (config.API_DOCS_ENABLED) {
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(apiSpec, {
      explorer: true,
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'API Documentation',
    }),
  );
}

if (config.RATE_LIMIT_ENABLED) {
  app.use('/v1/memcard', authRateLimitMiddleware);
}

// JWT verification guards all Memcard routes before any S3 access.
app.use('/v1/memcard', authMiddleware);

app.use(createOpenApiValidatorMiddleware(apiSpecPath));
app.use(errorHandlerMiddleware);

const server = app.listen(config.PORT, () => {
  logger.info(`Server is running on port ${config.PORT}`);
  // The resolved layout, printed once. The bucket may be shared with other
  // producers, and a wrong prefix does not fail — a missing object reads as a
  // brand-new player — so this line is what makes a misconfiguration visible.
  logger.info(
    `State objects: s3://${config.MEMCARD_S3_BUCKET}/${buildStateKey('{app}', '{userId}')}`,
  );
});

// In-flight requests drain first so their analytics records get dispatched,
// then the sinks are flushed/closed.
setupShutdown(server, config.SHUTDOWN_TIMEOUT_MS, {
  onDrained: analytics ? () => analytics.close() : undefined,
});
