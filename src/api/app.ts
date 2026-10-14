import express, { type Express } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pinoHttp } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { healthRouter } from './health.js';
import { authRouter } from './auth.js';
import { jobsRouter } from './jobs.js';
import { vehiclesRouter } from './vehicles.js';
import { intakeRouter } from './intake.js';
import { solveRouter } from './solve.js';
import { diagnosisRouter } from './diagnosis.js';
import { actionsRouter } from './actions.js';
import { technicianRouter } from './technician.js';
import { stockRouter } from './stock.js';
import { driverRouter } from './driver.js';
import { chatRouter } from './chat.js';
import { estimatesRouter } from './estimates.js';
import { consoleRouter } from './console.js';
import { escalationRouter } from './escalation.js';
import { webhooksRouter } from './webhooks.js';
import { checkoutRouter } from './checkout.js';
import { mountChaosRoutes } from './chaos.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { createQueueAdminRouter, BULL_BOARD_PATH } from '../queues/board.js';
import { errorHandler } from './middleware/errors.js';

/**
 * Builds the Express app but does not start it. index.ts owns the listen call;
 * keeping construction separate means tests (Supertest, from Phase 2 onward)
 * can exercise routes without binding a port.
 */
export function createApp(): Express {
  const app = express();

  // Trust the platform's proxy so req.ip and protocol are the client's, not the
  // load balancer's. Safe here because we only ever run behind one.
  app.set('trust proxy', 1);

  // Every log line for a request carries the same request id. If the client
  // sent an x-request-id we keep it so a trace can be followed across hops;
  // otherwise we mint one and echo it back in the response.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const header = req.headers['x-request-id'];
        const incoming = Array.isArray(header) ? header[0] : header;
        const id = incoming && incoming.length > 0 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );

  // Minimal CORS: echo the Origin only when it is on the configured allowlist.
  // Wired now so CORS_ORIGINS is a real, tested config value rather than a
  // placeholder that goes stale before the frontend arrives.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // BEFORE THE JSON PARSER, and that ordering is load-bearing rather than
  // stylistic. A Razorpay webhook is authenticated by an HMAC over the exact
  // bytes that arrived, and `express.json` consumes the stream and leaves only a
  // parsed object — re-serialising it does not reproduce those bytes, so the
  // signature would never verify. The webhook router mounts `express.raw` on its
  // own path; every other route is unaffected. See src/api/webhooks.ts.
  app.use(webhooksRouter);

  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter);
  app.use(authRouter);
  app.use(jobsRouter);
  app.use(vehiclesRouter);
  app.use(intakeRouter);
  app.use(solveRouter);
  app.use(diagnosisRouter);
  app.use(actionsRouter);
  app.use(technicianRouter);
  app.use(stockRouter);
  app.use(driverRouter);
  app.use(chatRouter);
  app.use(estimatesRouter);
  app.use(consoleRouter);
  app.use(escalationRouter);
  app.use(checkoutRouter);
  // Registers nothing in a production build — see src/api/chaos.ts.
  mountChaosRoutes(app);

  // Bull Board — dispatcher-only. Mounted with explicit `authenticate` +
  // `requirePermission`, the same pattern jobs.ts and intake.ts use, and for
  // the same reason: a router-level `use(authenticate)` with no path would
  // guard every request that reaches it, including the static files and pages
  // mounted after this one (see the Phase 4 bug this exact mistake caused).
  app.use(BULL_BOARD_PATH, authenticate, requirePermission('read', 'queueAdmin'), createQueueAdminRouter());

  // THE FRONTEND, served as plain files. No bundler, no build step: the browser
  // loads the ES modules in /public/js directly, and Bootstrap and morphdom
  // come from a CDN. Mounted AFTER the API routers so a static file can never
  // shadow an endpoint.
  //
  // `../../public` resolves the same from src/api (under tsx) and dist/api
  // (built), because dist mirrors src one level down from the project root.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../../public');
  app.use(express.static(publicDir));

  // Extensionless URLs, because /driver reads better than /driver.html. These
  // three are the paths the Phase 4 check names. /fleet was a fourth until the
  // fleet manager's dashboard was cut — the tenancy it read through is still
  // here, the surface that displayed it is not.
  for (const page of ['driver', 'technician', 'dispatcher']) {
    app.get(`/${page}`, (_req, res) => {
      res.sendFile(join(publicDir, `${page}.html`));
    });
  }

  // Last: turns any error thrown or forwarded by a route into clean JSON.
  app.use(errorHandler);

  return app;
}
