// PRISMA CLIENT EXTENSION — the third layer of read isolation, after RBAC and
// tenant scoping.
//
// RBAC (src/auth/permissions.ts `can()`) decides that a DRIVER and a TECHNICIAN
// may read jobs at all. Tenant scoping (src/infra/tenantScopeExtension.ts)
// limits every caller to their own tenant's jobs. This layer narrows those two
// roles one step further: a DRIVER sees only the jobs they raised, a TECHNICIAN
// only the jobs assigned to them. DISPATCHER and FLEET_MANAGER are untouched
// here — their only limit is the tenant filter.
//
// The rule itself lives in the permission layer (`jobReadOwnershipFilter`);
// this file only applies it, so route handlers never have to remember to. It
// AND-composes the filter into the query, exactly like the tenant extension, so
// it can only ever narrow a result set. Order relative to the tenant extension
// does not matter: both only add `AND` clauses.
//
// Scope: READS of the Job model only. It does not constrain writes — a
// TECHNICIAN's `update` permission is not row-limited here (see DECISIONS.log).

import { Prisma } from '@prisma/client';
import { getAuthContext } from '../auth/context.js';
import { jobReadOwnershipFilter } from '../auth/permissions.js';
import { isReadOperation } from '../auth/tenantScope.js';

type QueryArgs = { where?: Record<string, unknown> };

function withOwnershipFilter(args: QueryArgs, ownership: Record<string, unknown>): QueryArgs {
  const existingWhere = args.where ?? {};
  // AND-composing rather than spreading the key in, so a `where` the caller
  // already set on driverId / assignedTechnicianId cannot override it.
  return { ...args, where: { AND: [existingWhere, ownership] } };
}

// findUnique / findUniqueOrThrow only accept unique fields in `where`, so the
// ownership key cannot be injected there. Check the returned row instead.
function rowIsOwned(row: unknown, ownership: Record<string, unknown>): boolean {
  if (!row || typeof row !== 'object') return true;
  for (const [key, value] of Object.entries(ownership)) {
    if ((row as Record<string, unknown>)[key] !== value) return false;
  }
  return true;
}

export const jobOwnershipExtension = Prisma.defineExtension({
  name: 'job-ownership',
  query: {
    job: {
      async $allOperations({ operation, args, query }) {
        const ownership = jobReadOwnershipFilter(getAuthContext());

        // Empty object: a role with tenant-wide read (DISPATCHER, FLEET_MANAGER)
        // or no auth context at all. Nothing to narrow.
        if (Object.keys(ownership).length === 0) {
          return query(args);
        }

        // Only reads are row-limited. A write keeps whatever `where` it was
        // given (and is already tenant-scoped by the other extension).
        if (!isReadOperation(operation)) {
          return query(args);
        }

        if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
          const result = await query(args);
          if (rowIsOwned(result, ownership)) return result;
          if (operation === 'findUniqueOrThrow') {
            throw new Error('No Job found');
          }
          return null;
        }

        return query(withOwnershipFilter((args ?? {}) as QueryArgs, ownership));
      },
    },
  },
});
