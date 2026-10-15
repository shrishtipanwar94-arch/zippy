// Tenant isolation, end to end, against a real Postgres (the `zippy_test`
// database, created and migrated here). Mocks would prove nothing — the whole
// point is that the Prisma extension rewrites real queries.

import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prisma, prismaBase } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import { runWithAuthContext } from '../src/auth/context.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { hashPassword } from '../src/auth/passwords.js';

const app = createApp();
const FIXTURE_PASSWORD = 'p2-fixture-secret';

async function clearFixture(): Promise<void> {
  await prismaBase.auditLog.deleteMany({ where: { actorId: { startsWith: 'p2-' } } });
  await prismaBase.job.deleteMany({ where: { id: { startsWith: 'p2-' } } });
  await prismaBase.vehicle.deleteMany({ where: { id: { startsWith: 'p2-' } } });
  await prismaBase.driver.deleteMany({ where: { id: { startsWith: 'p2-' } } });
  await prismaBase.tenantMembership.deleteMany({ where: { id: { startsWith: 'p2-' } } });
  await prismaBase.user.deleteMany({ where: { id: { startsWith: 'p2-' } } });
  await prismaBase.tenant.deleteMany({ where: { id: { startsWith: 'p2-' } } });
  await prismaBase.zone.deleteMany({ where: { id: { startsWith: 'p2-' } } });
  await prismaBase.vehicleProfile.deleteMany({ where: { id: { startsWith: 'p2-' } } });
}

async function buildFixture(): Promise<void> {
  await prismaBase.zone.create({
    data: {
      id: 'p2-zone',
      code: 'P2Z',
      name: 'Fixture Zone',
      city: 'Delhi',
      centroidLat: 28.58,
      centroidLng: 77.185,
    },
  });
  await prismaBase.vehicleProfile.create({
    data: {
      id: 'p2-profile',
      make: 'TEST',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });

  const passwordHash = await hashPassword(FIXTURE_PASSWORD);

  for (const suffix of ['a', 'b'] as const) {
    const tenantId = `p2-tenant-${suffix}`;
    await prismaBase.tenant.create({ data: { id: tenantId, name: `Tenant ${suffix}`, kind: 'FLEET' } });

    await prismaBase.user.create({
      data: {
        id: `p2-fm-${suffix}`,
        email: `p2-fm-${suffix}@example.test`,
        passwordHash,
        role: 'FLEET_MANAGER',
        name: `FM ${suffix}`,
        memberships: { create: { id: `p2-mem-${suffix}`, tenantId, role: 'FLEET_MANAGER' } },
      },
    });

    await prismaBase.user.create({
      data: {
        id: `p2-drv-${suffix}`,
        email: `p2-drv-${suffix}@example.test`,
        passwordHash,
        role: 'DRIVER',
        name: `Driver ${suffix}`,
        driver: { create: { id: `p2-driver-${suffix}`, tenantId } },
      },
    });

    await prismaBase.vehicle.create({
      data: {
        id: `p2-veh-${suffix}`,
        driverId: `p2-driver-${suffix}`,
        tenantId,
        profileId: 'p2-profile',
        registration: `P2-${suffix.toUpperCase()}-0001`,
        colour: 'White',
      },
    });

    await prismaBase.job.create({
      data: {
        id: `p2-job-${suffix}`,
        tenantId,
        driverId: `p2-driver-${suffix}`,
        vehicleId: `p2-veh-${suffix}`,
        zoneId: 'p2-zone',
      },
    });
  }

  await prismaBase.user.create({
    data: {
      id: 'p2-dispatcher',
      email: 'p2-dispatcher@example.test',
      passwordHash,
      role: 'DISPATCHER',
      name: 'Dispatcher',
    },
  });
}

beforeAll(async () => {
  execSync('npx prisma migrate deploy', { stdio: 'ignore' });
  await clearFixture();
  await buildFixture();
}, 60_000);

afterAll(async () => {
  await clearFixture();
  await prismaBase.$disconnect().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  redis.disconnect();
});

const fmAToken = () =>
  issueAccessToken({ sub: 'p2-fm-a', role: 'FLEET_MANAGER', tenantId: 'p2-tenant-a', crossTenant: false });
const fmBToken = () =>
  issueAccessToken({ sub: 'p2-fm-b', role: 'FLEET_MANAGER', tenantId: 'p2-tenant-b', crossTenant: false });
const dispatcherToken = () =>
  issueAccessToken({ sub: 'p2-dispatcher', role: 'DISPATCHER', tenantId: null, crossTenant: true });

// The extension reads the auth context when the query EXECUTES, not when it is
// constructed. In production the authenticate middleware wraps the whole
// request, so this is automatic; here each helper must await inside the
// context callback so the query resolves while the context is still set.
function asUser<T>(
  ctx: { userId: string; role: 'FLEET_MANAGER' | 'DISPATCHER'; tenantId: string | null; crossTenant: boolean },
  work: () => Promise<T>,
): Promise<T> {
  return runWithAuthContext(ctx, work);
}

describe('the Prisma extension scopes queries by tenant', () => {
  it('a scoped caller sees only their own tenant rows', async () => {
    const jobs = await asUser(
      { userId: 'p2-fm-a', role: 'FLEET_MANAGER', tenantId: 'p2-tenant-a', crossTenant: false },
      async () => await prisma.job.findMany({ where: { id: { startsWith: 'p2-' } } }),
    );
    expect(jobs.map((j) => j.id)).toEqual(['p2-job-a']);
  });

  it('a query with NO auth context returns nothing, not everything', async () => {
    const jobs = await prisma.job.findMany({ where: { id: { startsWith: 'p2-' } } });
    expect(jobs).toEqual([]);
  });

  it('a cross-tenant (DISPATCHER) caller sees every tenant', async () => {
    const jobs = await asUser(
      { userId: 'p2-dispatcher', role: 'DISPATCHER', tenantId: null, crossTenant: true },
      async () => await prisma.job.findMany({ where: { id: { startsWith: 'p2-' } } }),
    );
    expect(jobs.map((j) => j.id).sort()).toEqual(['p2-job-a', 'p2-job-b']);
  });

  it('writes an audit row for a cross-tenant read', async () => {
    await prismaBase.auditLog.deleteMany({ where: { actorId: 'p2-dispatcher' } });
    await asUser(
      { userId: 'p2-dispatcher', role: 'DISPATCHER', tenantId: null, crossTenant: true },
      async () => await prisma.job.findFirst({ where: { id: 'p2-job-b' } }),
    );
    const audits = await prismaBase.auditLog.findMany({ where: { actorId: 'p2-dispatcher' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorRole: 'DISPATCHER',
      resource: 'Job',
      resourceId: 'p2-job-b',
      crossTenant: true,
    });
  });
});

describe('GET /jobs — tenant scoping through the route', () => {
  it('returns 200 and the job for its own tenant', async () => {
    const res = await request(app).get('/jobs/p2-job-a').set('Authorization', `Bearer ${fmAToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe('p2-job-a');
  });

  it('returns 404 (not 403) for another tenant\'s job — existence is not leaked', async () => {
    const res = await request(app).get('/jobs/p2-job-b').set('Authorization', `Bearer ${fmAToken()}`);
    expect(res.status).toBe(404);
  });

  it('the reverse also holds: FM-B cannot see job A', async () => {
    const res = await request(app).get('/jobs/p2-job-a').set('Authorization', `Bearer ${fmBToken()}`);
    expect(res.status).toBe(404);
  });

  it('the list is scoped too', async () => {
    const res = await request(app).get('/jobs').set('Authorization', `Bearer ${fmAToken()}`);
    expect(res.status).toBe(200);
    const ids = (res.body.jobs as { id: string }[]).map((j) => j.id).filter((id) => id.startsWith('p2-'));
    expect(ids).toEqual(['p2-job-a']);
  });

  it('a DISPATCHER list sees both jobs', async () => {
    const res = await request(app).get('/jobs').set('Authorization', `Bearer ${dispatcherToken()}`);
    expect(res.status).toBe(200);
    const ids = (res.body.jobs as { id: string }[]).map((j) => j.id).filter((id) => id.startsWith('p2-'));
    expect(ids.sort()).toEqual(['p2-job-a', 'p2-job-b']);
  });

  it('rejects a request with no token', async () => {
    const res = await request(app).get('/jobs/p2-job-a');
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/login', () => {
  it('issues tokens for the right password and 401s for a wrong one', async () => {
    const ok = await request(app)
      .post('/auth/login')
      .send({ email: 'p2-fm-a@example.test', password: FIXTURE_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toEqual(expect.any(String));
    expect(ok.body.user).toMatchObject({ role: 'FLEET_MANAGER', tenantId: 'p2-tenant-a' });

    const bad = await request(app)
      .post('/auth/login')
      .send({ email: 'p2-fm-a@example.test', password: 'wrong' });
    expect(bad.status).toBe(401);
  });

  it('a DISPATCHER login carries no tenant', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'p2-dispatcher@example.test', password: FIXTURE_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.tenantId).toBeNull();
  });
});
