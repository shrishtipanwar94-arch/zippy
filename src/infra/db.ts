import { config } from './config.js';
import { prismaBase } from './prismaBase.js';
import { tenantScopeExtension } from './tenantScopeExtension.js';
import { jobOwnershipExtension } from './jobOwnershipExtension.js';

/**
 * The Prisma client the application uses. It is `prismaBase` wrapped in two
 * read-isolation extensions:
 *   - tenant-scope: every query on a tenant-scoped model is filtered to the
 *     caller's tenant (see tenantScopeExtension.ts).
 *   - job-ownership: a DRIVER or TECHNICIAN reading jobs is narrowed further to
 *     the jobs that are theirs (see jobOwnershipExtension.ts). This only ever
 *     narrows on top of the tenant filter.
 * Postgres is the source of truth for every hold and reservation (invariant 1);
 * this is how the rest of the code reaches it.
 *
 * `prismaBase` is re-exported for the few callers that genuinely need the
 * unscoped client (the extension's own audit writes, test fixtures).
 */
function createExtendedClient() {
  return prismaBase.$extends(tenantScopeExtension).$extends(jobOwnershipExtension);
}

type ExtendedPrismaClient = ReturnType<typeof createExtendedClient>;

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrismaClient };

export const prisma = globalForPrisma.prisma ?? createExtendedClient();

if (!config.isProduction) {
  globalForPrisma.prisma = prisma;
}

export { prismaBase };
