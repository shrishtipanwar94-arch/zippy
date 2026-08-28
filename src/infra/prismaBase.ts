import { PrismaClient } from '@prisma/client';
import { config } from './config.js';

/**
 * The raw Prisma client, with no extensions. Almost nothing should import this
 * directly — application code uses the tenant-scoped `prisma` from db.js. The
 * exceptions are the tenant-scope extension itself (which writes audit rows and
 * must not re-enter its own hook) and test fixtures that need to set up data
 * without scoping getting in the way.
 *
 * Cached on globalThis in dev so `tsx watch` reloads reuse one connection pool
 * instead of exhausting Postgres.
 */
const globalForPrisma = globalThis as unknown as { prismaBase?: PrismaClient };

export const prismaBase =
  globalForPrisma.prismaBase ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

if (!config.isProduction) {
  globalForPrisma.prismaBase = prismaBase;
}
