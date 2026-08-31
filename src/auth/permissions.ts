// The permission table. Role -> resource -> the actions that role may take on
// it. One data structure, queried through one function `can()`. RBAC checks
// must never be scattered if-statements across route handlers — when someone
// asks "what can a technician do?" the answer has to be readable in one place.
//
// This governs the ACTION (may this role read a job at all?). WHICH rows a
// caller may see is decided in two more places, both here in the permission
// layer, both enforced by Prisma client extensions rather than route handlers:
//   - tenant scoping — every caller is limited to their own tenant's rows
//     (src/infra/tenantScopeExtension.ts, rule in ./tenantScope.ts)
//   - row ownership  — a DRIVER or TECHNICIAN is narrowed further, to the jobs
//     that are theirs (jobReadOwnershipFilter below, applied by
//     src/infra/jobOwnershipExtension.ts)
// A FLEET_MANAGER may `read` `job` and sees every job in their tenant; a DRIVER
// may `read` `job` and sees only their own.

import type { Role } from '@prisma/client';
import type { AuthContext } from './context.js';

export type Action = 'read' | 'create' | 'update' | 'delete';
// `queueAdmin` and `solverRun` are their own resources rather than role
// checks in a route. A TECHNICIAN legitimately has `update` on `job` (they
// progress their own work), so "may update a job" is not the same question as
// "may run the solver" — and the answer to both has to stay readable in one
// table instead of an if-statement in a handler.
export type Resource =
  | 'job'
  | 'unit'
  | 'technician'
  | 'driver'
  | 'user'
  | 'auditLog'
  | 'queueAdmin'
  | 'solverRun'
  // Re-diagnosing a job on site. TECHNICIAN-only and deliberately separate
  // from `job`: a dispatcher may update a job without being the person
  // standing at the roadside looking at the engine, and only that person
  // should be able to overwrite what the fault is.
  | 'jobDiagnosis'
  // A technician's own field actions: answering an offer, and climbing the
  // status ladder. Separate from `job` because a DISPATCHER may update a job
  // without being the person standing next to it — only the technician who was
  // sent may say they have arrived.
  | 'technicianAction'
  // Chat on a job, and the flagged messages waiting on a human. Two resources
  // rather than one: reading a conversation and turning part of it into a
  // dispatch change are different acts, and only the second writes to the job.
  // WHICH promotions a given role may confirm is a further question, and
  // deliberately not answered here — it depends on the promotion's KIND, not
  // only on the role (a dispatcher may confirm a location correction and may
  // not confirm a safety change, because they cannot see the traffic). That
  // rule lives in src/domain/promotionPolicy.ts.
  | 'chatMessage'
  | 'eventPromotion'
  | 'actionRequest'
  // Taking one of the solver's competing plans. Its own resource because it is
  // the one console action that WRITES — everything else the console does is a
  // read, and being allowed to look at plans is not the same as being allowed
  // to commit the board to one.
  | 'planSelection';

type PermissionTable = Record<Role, Partial<Record<Resource, Action[]>>>;

const PERMISSIONS: PermissionTable = {
  DRIVER: {
    job: ['read', 'create'],
    driver: ['read'],
    chatMessage: ['read', 'create'],
    // A driver confirms exactly one KIND of promotion — a safety change — and
    // that narrowing is promotionPolicy's, not this table's.
    eventPromotion: ['read', 'update'],
  },
  TECHNICIAN: {
    job: ['read', 'update'],
    unit: ['read'],
    technician: ['read'],
    // Only the person on site may overwrite what the fault is.
    jobDiagnosis: ['update'],
    // Read their own board (open offers and the job in hand); accept or
    // decline an offer; climb the status ladder; enter the driver's
    // completion code.
    technicianAction: ['read', 'update'],
    chatMessage: ['read', 'create'],
    eventPromotion: ['read', 'update'],
  },
  DISPATCHER: {
    job: ['read', 'create', 'update', 'delete'],
    // Running the solver and reading its plans. DISPATCHER-only: a plan is a
    // recommendation about the whole fleet, not something one driver or
    // technician has any business triggering.
    solverRun: ['read'],
    // The RECOMMEND and APPROVE queues. A dispatcher executes a recommended
    // reassignment and signs off an escalation; nobody else sees either.
    actionRequest: ['read', 'update'],
    planSelection: ['update'],
    chatMessage: ['read', 'create'],
    eventPromotion: ['read', 'update'],
    // Bull Board at /admin/queues — reads queue state, can retry or discard a
    // job. An operator surface, so it gets the operator role.
    queueAdmin: ['read'],
    unit: ['read', 'update'],
    technician: ['read'],
    driver: ['read'],
    user: ['read'],
    auditLog: ['read'],
  },
  FLEET_MANAGER: {
    job: ['read'],
    driver: ['read'],
    unit: ['read'],
    technician: ['read'],
  },
};

export function can(user: { role: Role }, action: Action, resource: Resource): boolean {
  const allowed = PERMISSIONS[user.role][resource];
  if (!allowed) return false;
  return allowed.includes(action);
}

// ROW OWNERSHIP — the third layer, on top of RBAC and tenant scoping.
//
// `can()` lets a DRIVER and a TECHNICIAN read jobs. This says WHICH job rows:
//   DRIVER      -> only jobs they raised          (Job.driverId === their Driver.id)
//   TECHNICIAN  -> only jobs assigned to them     (Job.assignedTechnicianId === their Technician.id)
//   everyone else (DISPATCHER, FLEET_MANAGER) -> no extra narrowing; their only
//     limit is the tenant filter.
//
// The return value is a Prisma `where` fragment that jobOwnershipExtension.ts
// AND-composes into every job read. It is composed ON TOP of the tenant filter,
// never in place of it — this can only ever narrow a result set, never widen
// one.

// A Driver/Technician id that cannot exist. Used when the token says DRIVER or
// TECHNICIAN but carries no actorId (a user with no Driver/Technician row).
// Filtering by it returns zero rows — a missing scope must fail closed, the
// same rule as NO_TENANT in tenantScope.ts.
export const NO_OWNER = '__no_owner__';

export type JobOwnershipFilter =
  | Record<string, never>
  | { driverId: string }
  | { assignedTechnicianId: string };

export function jobReadOwnershipFilter(context: AuthContext | undefined): JobOwnershipFilter {
  if (context?.role === 'DRIVER') {
    return { driverId: context.actorId ?? NO_OWNER };
  }
  if (context?.role === 'TECHNICIAN') {
    return { assignedTechnicianId: context.actorId ?? NO_OWNER };
  }
  return {};
}
