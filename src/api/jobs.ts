// GET /jobs      list jobs the caller may see
// GET /jobs/:id  one job, or 404
//
// These routes never filter by tenant themselves. `authenticate` puts the
// caller's tenant in context and the Prisma extension scopes every query. A
// FLEET_MANAGER asking for another tenant's job therefore gets a 404 (the
// scoped lookup found nothing) — not a 403, which would confirm the job
// exists.

import { Router } from 'express';
import { prisma } from '../infra/db.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';

export const jobsRouter = Router();

// `authenticate` is attached PER ROUTE, not with `jobsRouter.use(authenticate)`.
// A router-level `use` with no path runs for every request that reaches the
// router, not only the ones it handles — so it would 401 anything mounted after
// it, static files included. Nothing noticed while the app was API-only and
// every unmatched request 404'd anyway; the frontend made it visible.

jobsRouter.get('/jobs', authenticate, requirePermission('read', 'job'), async (_req, res) => {
  const jobs = await prisma.job.findMany({
    take: 50,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      safetyLevel: true,
      tenantId: true,
      createdAt: true,
      assignedUnitId: true,
      assignedTechnicianId: true,
    },
  });
  res.json({ jobs });
});

jobsRouter.get('/jobs/:id', authenticate, requirePermission('read', 'job'), async (req, res) => {
  const id = req.params.id;
  if (typeof id !== 'string' || id.length === 0) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  // findFirst, not findUnique, so the extension can add the tenant filter to
  // `where` rather than having to post-check the row.
  const job = await prisma.job.findFirst({
    where: { id },
    select: { id: true, status: true, safetyLevel: true, tenantId: true, createdAt: true },
  });
  if (!job) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ job });
});
