import { config } from './config.js';
import { prismaBase } from './prismaBase.js';
import { tenantScopeExtension } from './tenantScopeExtension.js';

/**
 * The Prisma client the application uses. It is `prismaBase` wrapped in the
 * tenant-scope extension, so every query on a tenant-scoped model is filtered
 * to the caller's tenant (see tenantScopeExtension.ts). Postgres is the source
 * of truth for every hold and reservation (invariant 1); this is how the rest
 * of the code reaches it.
 *
 * `prismaBase` is re-exported for the few callers that genuinely need the
 * unscoped client (the extension's own audit writes, test fixtures).
 */
function createExtendedClient() {
  return prismaBase.$extends(tenantScopeExtension);
}

type ExtendedPrismaClient = ReturnType<typeof createExtendedClient>;

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrismaClient };

export const prisma = globalForPrisma.prisma ?? createExtendedClient();

if (!config.isProduction) {
  globalForPrisma.prisma = prisma;
}

export { prismaBase };
