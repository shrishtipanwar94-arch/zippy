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
  // The money domain's two halves, and they are two resources rather than one
  // because they are done by different people. A TECHNICIAN prices what they
  // found; the DRIVER says whether they will pay for it. A technician who
  // could approve their own estimate is not a re-approval loop, it is a
  // formality — the pause is only worth anything because somebody else has to
  // say yes.
  | 'estimate'
  | 'estimateApproval'
  // Parts (Phase 18), and two resources rather than one because they answer
  // two different questions. `vanStock` is "my own van" — a technician reads
  // it and confirms a count in it. `fleetStock` is "any van", which is an
  // operator's view of the whole fleet and is not something the person sitting
  // in one of those vans needs. Splitting them is what keeps /units/:id/stock
  // from having to work out whether the caller happens to be crewed to the
  // unit they asked about.
  | 'vanStock'
  | 'fleetStock'
  | 'actionRequest'
  // Taking one of the solver's competing plans. Its own resource because it is
  // the one console action that WRITES — everything else the console does is a
  // read, and being allowed to look at plans is not the same as being allowed
  // to commit the board to one.
  | 'planSelection'
  // The chaos controls (Phase 17). Its own resource because breaking the
  // system on purpose is not "updating a job" — and because the route that
  // uses it does not exist in a production build at all, so this permission is
  // the second lock rather than the only one.
  | 'chaosControl'
  // Putting a vehicle on a tenant's books (Phase 20). Its own resource because
  // it is the one write a FLEET_MANAGER has, and "may read my fleet" should
  // not have quietly meant "may add to it".
  | 'vehicle'
  // The driver's own checkout (Phase 22b). Its own resource rather than part of
  // `estimate`, because approving what a repair costs and paying for it are
  // different acts by the same person — and because a DISPATCHER may answer an
  // estimate on a driver's behalf over the phone, which is exactly the thing
  // nobody may do with somebody else's card.
  | 'payment'
  // THE STUCK-AUTHORISATION LIST behind the health banner (Phase 22b). Its own
  // resource, and the reason is a mistake worth recording: the first version of
  // this route reused `payment: ['read']` and granted it to DISPATCHER — which
  // ALSO handed it to every DRIVER, who already holds full payment permission
  // for their own checkout. `requirePermission` asks what the role may do, not
  // whose row this is, so that would have let any signed-in driver read every
  // outstanding payment in the fleet. A route that is about the SYSTEM's health
  // rather than about one person's money needs a resource that says so.
  | 'paymentBacklog';

type PermissionTable = Record<Role, Partial<Record<Resource, Action[]>>>;

const PERMISSIONS: PermissionTable = {
  DRIVER: {
    job: ['read', 'create'],
    driver: ['read'],
    chatMessage: ['read', 'create'],
    // A driver confirms exactly one KIND of promotion — a safety change — and
    // that narrowing is promotionPolicy's, not this table's.
    eventPromotion: ['read', 'update'],
    // They see what it costs, and they are the only role that can answer.
    estimate: ['read'],
    estimateApproval: ['update'],
    // Opens their own checkout and reports back from it. DRIVER-only: nobody
    // pays on somebody else's behalf.
    payment: ['read', 'create', 'update'],
    // READ, never create. A driver picks which of their cars has broken down
    // from a list of number plates; registering one is a fleet manager's or a
    // dispatcher's act.
    vehicle: ['read'],
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
    // Prices what they found; cannot approve it.
    estimate: ['read', 'create'],
    // What is in their van, and the count that makes it believable again.
    vanStock: ['read', 'update'],
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
    // Dispatcher-only, and only in a dev or demo build.
    chaosControl: ['read', 'update'],
    chatMessage: ['read', 'create'],
    eventPromotion: ['read', 'update'],
    // A dispatcher reads estimates and may answer one on the driver's behalf —
    // a driver on a roadside with no signal still has a phone call, and the
    // approval records the channel so "approved in the app" and "approved over
    // the phone" are distinguishable afterwards.
    estimate: ['read'],
    estimateApproval: ['update'],
    // Bull Board at /admin/queues — reads queue state, can retry or discard a
    // job. An operator surface, so it gets the operator role.
    queueAdmin: ['read'],
    unit: ['read', 'update'],
    technician: ['read'],
    driver: ['read'],
    // A dispatcher registers a vehicle on a fleet's behalf — a phone call to
    // the desk is how half of these actually arrive.
    vehicle: ['read', 'create'],
    user: ['read'],
    auditLog: ['read'],
    // Any van's parts, and how stale the count is. Read-only: a dispatcher who
    // could correct a stock level from a desk would be guessing at what is in
    // a vehicle they cannot see, and the whole point of Phase 18 is that only
    // the person who looked may say.
    fleetStock: ['read'],
    // The stuck-authorisation list behind the health banner, and nothing else
    // about money. NOT `payment` — see that resource's comment for why reusing
    // it would have opened the same list to every driver.
    paymentBacklog: ['read'],
  },
  FLEET_MANAGER: {
    job: ['read'],
    // Registers vehicles into their own fleet. The tenant comes off the token,
    // never off the body — see src/api/vehicles.ts.
    vehicle: ['read', 'create'],
    driver: ['read'],
    unit: ['read'],
    technician: ['read'],
    fleetStock: ['read'],
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

// WHICH VEHICLES A DRIVER MAY REPORT A BREAKDOWN ON.
//
// One rule with two readers, and they disagreed. `GET /vehicles` fills the
// picker on the driver's request screen and was scoped by TENANT alone, so a
// Metrocab driver was offered both Metrocab cars; `POST /jobs/intake` matches
// on `driverId` and refuses anything else with a 404. The picker therefore
// offered a choice that could only fail, and the driver's only clue was
// "vehicle not found" on a car they had just picked from a list we gave them.
//
// Unlike the job filter above this takes a DRIVER ID rather than the auth
// context, because the two callers know the subject driver by different
// routes: the picker knows it from the token, and intake knows it from the
// token OR from `driverId` in the body, because a dispatcher may file on
// somebody's behalf. The rule is about the driver, so the driver is what it
// takes.
//
// It always narrows. A caller with no subject driver must not call it — see
// the note in src/api/vehicles.ts about why a dispatcher browsing the fleet is
// asking a different question.
export type VehicleFilingFilter = { driverId: string };

export function vehicleFilingFilter(driverId: string | null | undefined): VehicleFilingFilter {
  // Fails closed on a DRIVER token with no Driver row, exactly as the job
  // filter does: an id that cannot exist returns no rows rather than all rows.
  return { driverId: driverId ?? NO_OWNER };
}
