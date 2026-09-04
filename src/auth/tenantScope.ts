// The pure decisions behind tenant scoping. No Prisma, no I/O — just "given
// this auth context, what tenant value should a query be filtered by?" so the
// rule can be unit-tested on its own. The extension that applies it to real
// queries is src/infra/tenantScopeExtension.ts.

import type { AuthContext } from './context.js';

// Models with a direct `tenantId` column. A query on any of these is filtered;
// a query on anything else (Unit, Technician, Zone, User, AuditLog...) is left
// alone.
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'Job',
  'Vehicle',
  'Driver',
  'Payment',
  'Contract',
]);

// A tenant id that cannot exist, used when the request has no tenant. Filtering
// by it returns zero rows — the safe direction. A missing scope must never
// widen a query.
export const NO_TENANT = '__no_tenant__';

export function isTenantScopedModel(model: string | undefined): boolean {
  return model !== undefined && TENANT_SCOPED_MODELS.has(model);
}

// null  -> do not filter (a DISPATCHER sees every tenant; the read is audited)
// string -> the value every `tenantId` in the query must equal
export function tenantFilterValue(context: AuthContext | undefined): string | null {
  if (context?.crossTenant) return null;
  if (context?.tenantId) return context.tenantId;
  return NO_TENANT;
}

// A TECHNICIAN'S AUTHORITY OVER A JOB IS ASSIGNMENT, NOT TENANT MEMBERSHIP.
//
// The fleet is shared. The solver picks the best crew for a job wherever that
// crew's own membership happens to sit, and APPROVE_CROSS_TENANT_CONTENTION
// exists precisely to arbitrate when two tenants want the same one — so a
// technician being assigned a job outside their own tenant is the design
// working, not an anomaly. Every technician belongs to exactly one of the three
// fleet tenants, so it is also the common case rather than the edge.
//
// The tenant filter then hid the job from the one person standing next to the
// vehicle. They could climb the entire ladder, because those routes read
// through `prismaBase`, but could not read the job or price it, because those
// routes resolve it through the scoped client first. Two paths, one rule, and
// only one of them right — the same shape as KIND_LABEL, the driverUpdates
// whitelist and the population counts before it.
//
// So Job READS by a TECHNICIAN are exempt here, and narrowed instead by
// jobOwnershipExtension, which AND-composes `assignedTechnicianId = them`. That
// is strictly narrower than any tenant filter — it is one technician's own
// assigned jobs and nothing else — so this exemption cannot widen a result set.
//
// READS ONLY, and that restriction is load-bearing: the ownership extension
// deliberately does not constrain writes, so exempting writes here would let a
// technician update any job in the database by id. A technician's own writes go
// through `prismaBase` and are scoped by technicianId inside the commit layer.
export function technicianReadingOwnJob(
  model: string | undefined,
  operation: string,
  context: AuthContext | undefined,
): boolean {
  return context?.role === 'TECHNICIAN' && model === 'Job' && isReadOperation(operation);
}

const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

// Write operations we also constrain, so a scoped user cannot update or delete
// another tenant's row by id. `create`/`upsert` are deliberately not here —
// nested writes make automatic injection unsafe, so those paths must pass
// tenantId explicitly (there are none in Phase 2).
const CONSTRAINABLE_WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  'updateMany',
  'deleteMany',
  'update',
  'delete',
]);

export function isReadOperation(operation: string): boolean {
  return READ_OPERATIONS.has(operation);
}

export function operationTakesWhereFilter(operation: string): boolean {
  // findUnique / findUniqueOrThrow only accept unique fields in `where`, so
  // `tenantId` cannot be injected there — the extension checks their result
  // instead.
  if (operation === 'findUnique' || operation === 'findUniqueOrThrow') return false;
  return READ_OPERATIONS.has(operation) || CONSTRAINABLE_WRITE_OPERATIONS.has(operation);
}
