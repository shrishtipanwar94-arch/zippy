// GET /jobs      list jobs the caller may see
// GET /jobs/:id  one job, or 404
//
// These routes never filter by tenant themselves. `authenticate` puts the
// caller's tenant in context and the Prisma extension scopes every query. A
// FLEET_MANAGER asking for another tenant's job therefore gets a 404 (the
// scoped lookup found nothing) — not a 403, which would confirm the job
// exists.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../infra/db.js';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import {
  AssignmentError,
  assignUnitToJob,
  statusForAssignmentError,
} from '../commit/assignUnit.js';

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

// The dropdown's options. Units are not tenant-scoped, so every role that may
// read a unit sees all of them.
jobsRouter.get('/units', authenticate, requirePermission('read', 'unit'), async (_req, res) => {
  const units = await prisma.unit.findMany({
    orderBy: { code: 'asc' },
    select: { id: true, code: true, kind: true, status: true, zoneId: true },
  });
  res.json({ units });
});

const assignSchema = z.object({ unitId: z.string().min(1) }).strict();

// PATCH /jobs/:id/assign — PLACEHOLDER, deleted at Phase 9.
//
// A dispatcher picks a unit by hand so the walking skeleton has an action that
// visibly moves state on three surfaces at once. There is no allocation logic
// here and there deliberately is none: no candidate generation, no feasibility
// filtering, no cost. It does not check that the unit can actually do the job —
// a bike can be sent to a vehicle that needs a flatbed. That is Phase 7's
// feasibility filter, and pretending to do it here would mean writing the
// wrong version of it twice.
//
// `jobAssignment` is a DISPATCHER-only permission: a TECHNICIAN has `update` on
// `job` for their own work, and that must not extend to deciding who is sent.
jobsRouter.patch(
  '/jobs/:id/assign',
  authenticate,
  requirePermission('update', 'jobAssignment'),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }

    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const body = assignSchema.parse(req.body);

    // Resolved through the SCOPED client first, so a caller who cannot see the
    // job gets a 404 before any write is attempted. A DISPATCHER reads across
    // tenants, so this passes for them — the check is here so the route does
    // not become the one place that skips it.
    const visible = await prisma.job.findFirst({ where: { id }, select: { id: true } });
    if (!visible) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    try {
      const result = await assignUnitToJob(prismaBase, {
        jobId: visible.id,
        unitId: body.unitId,
        actor: { role: auth.role, id: auth.userId },
      });
      res.json(result);
    } catch (error) {
      if (error instanceof AssignmentError) {
        res.status(statusForAssignmentError(error)).json({ error: error.code.toLowerCase() });
        return;
      }
      throw error;
    }
  },
);
