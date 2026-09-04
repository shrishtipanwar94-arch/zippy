// PRISMA CLIENT EXTENSION — the second layer of tenant isolation.
//
// The first layer is middleware that puts the caller's tenant in an
// AsyncLocalStorage context. This is the layer that actually enforces it: a
// `query` extension that intercepts EVERY operation on a tenant-scoped model
// and, before the query runs, adds `AND tenantId = <caller's tenant>` to the
// filter. Route code does not — and must not — remember to scope its own
// queries. If it forgets, this still applies. If there is no tenant in context
// at all, the injected value is an id that cannot exist, so the query returns
// nothing rather than everything.
//
// A DISPATCHER is exempt from the filter (they investigate across tenants) but
// every cross-tenant read they make is written to the audit log here.
//
// KNOWN GAP: `$queryRaw` / `$executeRaw` bypass this hook. Hand-written SQL
// (from Phase 11) must scope itself.

import { Prisma } from '@prisma/client';
import type { AuthContext } from '../auth/context.js';
import { getAuthContext } from '../auth/context.js';
import {
  isReadOperation,
  isTenantScopedModel,
  operationTakesWhereFilter,
  technicianReadingOwnJob,
  tenantFilterValue,
} from '../auth/tenantScope.js';
import { prismaBase } from './prismaBase.js';

type QueryArgs = { where?: Record<string, unknown> };

function withTenantFilter(args: QueryArgs, tenantId: string): QueryArgs {
  const existingWhere = args.where ?? {};
  // AND-composing (rather than spreading `tenantId` in) so it cannot be
  // overwritten by a key already present in the caller's `where`.
  return { ...args, where: { AND: [existingWhere, { tenantId }] } };
}

function extractResourceId(args: QueryArgs, result: unknown): string | null {
  const whereId = args.where?.['id'];
  if (typeof whereId === 'string') return whereId;
  if (result && typeof result === 'object' && 'id' in result) {
    const id = (result as { id: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
}

async function writeCrossTenantAudit(
  context: AuthContext,
  model: string,
  operation: string,
  args: QueryArgs,
  result: unknown,
): Promise<void> {
  // prismaBase, not the extended client — otherwise this write would re-enter
  // the extension and recurse.
  await prismaBase.auditLog.create({
    data: {
      actorId: context.userId,
      actorRole: context.role,
      action: 'read',
      resource: model,
      resourceId: extractResourceId(args, result),
      crossTenant: true,
      detail: { operation },
    },
  });
}

export const tenantScopeExtension = Prisma.defineExtension({
  name: 'tenant-scope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!isTenantScopedModel(model)) {
          return query(args);
        }

        const context = getAuthContext();

        // A TECHNICIAN reading a Job is scoped by ASSIGNMENT rather than by
        // tenant — see technicianReadingOwnJob for why, and why it is reads
        // only. jobOwnershipExtension does the narrowing, and does it harder
        // than this filter would.
        if (technicianReadingOwnJob(model, operation, context)) {
          return query(args);
        }

        const tenantId = tenantFilterValue(context);
        const typedArgs = (args ?? {}) as QueryArgs;

        // tenantId === null: a DISPATCHER. Run unfiltered; audit the read.
        if (tenantId === null) {
          const result = await query(args);
          if (context && isReadOperation(operation)) {
            await writeCrossTenantAudit(context, model, operation, typedArgs, result);
          }
          return result;
        }

        // findUnique / findUniqueOrThrow only accept unique fields in `where`,
        // so tenantId cannot be injected. Run, then reject a foreign row.
        if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
          const result = await query(args);
          if (result && typeof result === 'object' && 'tenantId' in result) {
            const rowTenant = (result as { tenantId: string | null }).tenantId;
            if (rowTenant !== tenantId) {
              if (operation === 'findUniqueOrThrow') {
                throw new Error(`No ${model} found`);
              }
              return null;
            }
          }
          return result;
        }

        if (operationTakesWhereFilter(operation)) {
          return query(withTenantFilter(typedArgs, tenantId));
        }

        return query(args);
      },
    },
  },
});
