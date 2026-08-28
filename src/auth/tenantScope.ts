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
