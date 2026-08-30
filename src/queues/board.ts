// "Bull Board at /admin/queues, dispatcher-only." A read-only-by-permission
// dashboard over the same `Queue` objects everything else here uses — it does
// not talk to a Worker or hold its own connection, it just reads and writes
// the queues' state in Redis the same way `enqueueSolve` or a Worker does.
//
// MOUNTED ON THE WEB PROCESS, even though the Workers that DO the work live
// in the worker process. Bull Board is an HTTP dashboard; HTTP is the web
// process's job. A `Queue` object is cheap and stateless enough to construct
// wherever it is needed — the worker process builds its own set in
// runWorkers.ts to attach `Worker`s to, and this file builds a second set
// purely for the dashboard to read. Neither runs a processor.

import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { RequestHandler } from 'express';
import { queues, deadLetterQueue } from './queues.js';

// Exported, not duplicated at the mount site in app.ts — Bull Board's own
// internal links are built from this path, so the router MUST be mounted at
// exactly this URL or its assets and API calls 404.
export const BULL_BOARD_PATH = '/admin/queues';

export function createQueueAdminRouter(): RequestHandler {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);

  createBullBoard({
    queues: [...Object.values(queues), deadLetterQueue].map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
  });

  return serverAdapter.getRouter() as RequestHandler;
}
