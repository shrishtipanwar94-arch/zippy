import { PrismaClient } from '@prisma/client';
import { config } from './config.js';

/**
 * The single Prisma client for the process. Postgres is the source of truth for
 * every hold and reservation (invariant 1); this is how the rest of the code
 * reaches it.
 *
 * In dev, `tsx watch` reloads modules on every save. Without the global cache
 * below, each reload would open a fresh pool and Postgres would slowly run out
 * of connections. In production the module loads once and the cache is a no-op.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

if (!config.isProduction) {
  globalForPrisma.prisma = prisma;
}
