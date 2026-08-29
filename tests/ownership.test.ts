// Row ownership, end to end, against a real Postgres. RBAC lets a DRIVER and a
// TECHNICIAN read jobs; this proves they each see only the rows that are
// theirs, that a FLEET_MANAGER and a DISPATCHER still get the tenant-wide view,
// and that the narrowing rides on top of tenant scoping rather than replacing
// it. Enforcement is jobOwnershipExtension.ts, driven by the rule in
// src/auth/permissions.ts — no route handler filters by owner.

import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prisma, prismaBase } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { hashPassword } from '../src/auth/passwords.js';

const app = createApp();
const FIXTURE_PASSWORD = 'own-fixture-secret';
const TENANT = 'own-tenant';

async function clearFixture(): Promise<void> {
  await prismaBase.auditLog.deleteMany({ where: { actorId: { startsWith: 'own-' } } });
  await prismaBase.job.deleteMany({ where: { id: { startsWith: 'own-' } } });
  await prismaBase.vehicle.deleteMany({ where: { id: { startsWith: 'own-' } } });
  await prismaBase.driver.deleteMany({ where: { id: { startsWith: 'own-' } } });
  await prismaBase.technician.deleteMany({ where: { id: { startsWith: 'own-' } } });
  await prismaBase.tenantMembership.deleteMany({ where: { id: { startsWith: 'own-' } } });
  await prismaBase.user.deleteMany({ where: { id: { startsWith: 'own-' } } });
  await prismaBase.tenant.deleteMany({ where: { id: { startsWith: 'own-' } } });
  await prismaBase.vehicleProfile.deleteMany({ where: { id: { startsWith: 'own-' } } });
  await prismaBase.zone.deleteMany({ where: { id: { startsWith: 'own-' } } });
}

async function buildFixture(): Promise<void> {
  await prismaBase.zone.create({
    data: {
      id: 'own-zone',
      code: 'OWNZ',
      name: 'Ownership Zone',
      city: 'Bengaluru',
      centroidLat: 12.9,
      centroidLng: 77.6,
    },
  });
  await prismaBase.vehicleProfile.create({
    data: {
      id: 'own-profile',
      // Distinct make/model from other test fixtures: the unique key is
      // (make, model, yearFrom, yearTo), and suites share one database.
      make: 'TEST_OWNERSHIP',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });

  const passwordHash = await hashPassword(FIXTURE_PASSWORD);
  await prismaBase.tenant.create({ data: { id: TENANT, name: 'Ownership Tenant', kind: 'FLEET' } });

  // A fleet manager: reads every job in the tenant.
  await prismaBase.user.create({
    data: {
      id: 'own-fm',
      email: 'own-fm@example.test',
      passwordHash,
      role: 'FLEET_MANAGER',
      name: 'FM',
      memberships: { create: { id: 'own-mem-fm', tenantId: TENANT, role: 'FLEET_MANAGER' } },
    },
  });

  // Two drivers in the same tenant, one job each.
  for (const suffix of ['a', 'b'] as const) {
    await prismaBase.user.create({
      data: {
        id: `own-u-drv-${suffix}`,
        email: `own-drv-${suffix}@example.test`,
        passwordHash,
        role: 'DRIVER',
        name: `Driver ${suffix}`,
        memberships: { create: { id: `own-mem-drv-${suffix}`, tenantId: TENANT, role: 'DRIVER' } },
        driver: { create: { id: `own-drv-${suffix}`, tenantId: TENANT } },
      },
    });
    await prismaBase.vehicle.create({
      data: {
        id: `own-veh-${suffix}`,
        driverId: `own-drv-${suffix}`,
        tenantId: TENANT,
        profileId: 'own-profile',
        registration: `OWN-${suffix.toUpperCase()}-0001`,
        colour: 'White',
      },
    });
  }

  // One technician, assigned to driver A's job only.
  await prismaBase.user.create({
    data: {
      id: 'own-u-tech',
      email: 'own-tech@example.test',
      passwordHash,
      role: 'TECHNICIAN',
      name: 'Tech',
      memberships: { create: { id: 'own-mem-tech', tenantId: TENANT, role: 'TECHNICIAN' } },
      technician: { create: { id: 'own-tech', employeeCode: 'OWN-EMP-1', homeZoneId: 'own-zone' } },
    },
  });

  await prismaBase.job.create({
    data: {
      id: 'own-job-a',
      tenantId: TENANT,
      driverId: 'own-drv-a',
      vehicleId: 'own-veh-a',
      zoneId: 'own-zone',
      assignedTechnicianId: 'own-tech',
    },
  });
  await prismaBase.job.create({
    data: {
      id: 'own-job-b',
      tenantId: TENANT,
      driverId: 'own-drv-b',
      vehicleId: 'own-veh-b',
      zoneId: 'own-zone',
    },
  });

  // A dispatcher: no membership, reads across tenants.
  await prismaBase.user.create({
    data: {
      id: 'own-dispatcher',
      email: 'own-dispatcher@example.test',
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

const driverAToken = () =>
  issueAccessToken({ sub: 'own-u-drv-a', role: 'DRIVER', tenantId: TENANT, crossTenant: false, actorId: 'own-drv-a' });
const driverBToken = () =>
  issueAccessToken({ sub: 'own-u-drv-b', role: 'DRIVER', tenantId: TENANT, crossTenant: false, actorId: 'own-drv-b' });
const techToken = () =>
  issueAccessToken({ sub: 'own-u-tech', role: 'TECHNICIAN', tenantId: TENANT, crossTenant: false, actorId: 'own-tech' });
const fmToken = () =>
  issueAccessToken({ sub: 'own-fm', role: 'FLEET_MANAGER', tenantId: TENANT, crossTenant: false });
const dispatcherToken = () =>
  issueAccessToken({ sub: 'own-dispatcher', role: 'DISPATCHER', tenantId: null, crossTenant: true });

function listJobIds(token: string) {
  return request(app)
    .get('/jobs')
    .set('Authorization', `Bearer ${token}`)
    .then((res) => {
      expect(res.status).toBe(200);
      return (res.body.jobs as { id: string }[]).map((j) => j.id).filter((id) => id.startsWith('own-')).sort();
    });
}

describe('GET /jobs — row ownership on the list', () => {
  it('a DRIVER sees only the jobs they raised', async () => {
    expect(await listJobIds(driverAToken())).toEqual(['own-job-a']);
    expect(await listJobIds(driverBToken())).toEqual(['own-job-b']);
  });

  it('a TECHNICIAN sees only the jobs assigned to them', async () => {
    expect(await listJobIds(techToken())).toEqual(['own-job-a']);
  });

  it('a FLEET_MANAGER still sees every job in the tenant', async () => {
    expect(await listJobIds(fmToken())).toEqual(['own-job-a', 'own-job-b']);
  });

  it('a DISPATCHER still sees every job', async () => {
    expect(await listJobIds(dispatcherToken())).toEqual(['own-job-a', 'own-job-b']);
  });
});

describe('GET /jobs/:id — row ownership on a single fetch', () => {
  it('a DRIVER reading another driver\'s job in the same tenant gets 404 (not 403)', async () => {
    // own-job-b belongs to driver B; both drivers are in own-tenant, so tenant
    // scoping alone would let this through — row ownership is what 404s it.
    const res = await request(app).get('/jobs/own-job-b').set('Authorization', `Bearer ${driverAToken()}`);
    expect(res.status).toBe(404);
  });

  it('a TECHNICIAN reading a job not assigned to them gets 404', async () => {
    // own-job-b has no assignedTechnicianId and sits in the technician's tenant.
    const res = await request(app).get('/jobs/own-job-b').set('Authorization', `Bearer ${techToken()}`);
    expect(res.status).toBe(404);
  });

  it('a DISPATCHER reads both jobs successfully', async () => {
    const a = await request(app).get('/jobs/own-job-a').set('Authorization', `Bearer ${dispatcherToken()}`);
    expect(a.status).toBe(200);
    expect(a.body.job.id).toBe('own-job-a');

    const b = await request(app).get('/jobs/own-job-b').set('Authorization', `Bearer ${dispatcherToken()}`);
    expect(b.status).toBe(200);
    expect(b.body.job.id).toBe('own-job-b');
  });

  it('the owner still gets their own job — the filter is not over-aggressive', async () => {
    const driver = await request(app).get('/jobs/own-job-a').set('Authorization', `Bearer ${driverAToken()}`);
    expect(driver.status).toBe(200);
    expect(driver.body.job.id).toBe('own-job-a');

    const tech = await request(app).get('/jobs/own-job-a').set('Authorization', `Bearer ${techToken()}`);
    expect(tech.status).toBe(200);
    expect(tech.body.job.id).toBe('own-job-a');
  });
});

describe('the login path resolves the actor id', () => {
  it('a DRIVER who logs in through POST /auth/login is row-scoped on the token it returns', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'own-drv-a@example.test', password: FIXTURE_PASSWORD });
    expect(login.status).toBe(200);

    const res = await request(app).get('/jobs').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.jobs as { id: string }[]).map((j) => j.id).filter((id) => id.startsWith('own-'));
    expect(ids).toEqual(['own-job-a']);
  });
});
