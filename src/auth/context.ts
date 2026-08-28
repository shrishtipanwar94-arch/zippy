// REQUEST-SCOPED AUTH CONTEXT
//
// The Prisma tenant-scope extension (src/infra/tenantScopeExtension.ts) needs
// to know, for every query it intercepts, which user and tenant the request
// belongs to. Threading that through every function call would be noisy and
// easy to forget — and a forgotten scope is a cross-tenant leak.
//
// Node's AsyncLocalStorage solves this: `runWithAuthContext(ctx, fn)` makes
// `ctx` visible to `getAuthContext()` anywhere inside `fn`, including deep
// inside async calls, without a parameter. The authenticate middleware wraps
// the rest of each request in it. Outside a request (a worker, a script, a
// test that has not opted in) `getAuthContext()` returns undefined, and the
// extension treats that as "no tenant" — which returns nothing, not everything.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '@prisma/client';

export type AuthContext = {
  userId: string;
  role: Role;
  tenantId: string | null;
  // True only for a DISPATCHER: queries are not tenant-filtered, but every
  // cross-tenant read is written to the audit log.
  crossTenant: boolean;
};

const storage = new AsyncLocalStorage<AuthContext>();

export function runWithAuthContext<T>(context: AuthContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getAuthContext(): AuthContext | undefined {
  return storage.getStore();
}
