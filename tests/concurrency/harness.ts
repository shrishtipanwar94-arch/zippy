// A REAL POSTGRES, STARTED BY THE TEST — invariant 9.
//
// WHY NOT THE SHARED `zippy_test` DATABASE. Every other suite in this repo
// points at a database a human started by hand, which is fine for tests that
// assert on their own rows. It is not fine here. These tests are the proof
// that two writers cannot both take one unit, and a proof that only runs if
// someone remembered to `docker compose up` first is not a proof — it is a
// note saying the property was checked once, on a machine that no longer
// exists. Testcontainers starts a throwaway Postgres 16, runs the real
// migrations into it, and throws it away afterwards, so the guarantee is
// reproducible on a machine that has never seen this project.
//
// WHY NOT MOCKS. A mocked database cannot lose a race. The entire behaviour
// under test — `WHERE version = $2` matching zero rows — lives in Postgres,
// so a mock would be testing the mock's own idea of what an UPDATE does.
//
// COST, STATED HONESTLY: starting a container and running migrations takes
// seconds, which is why this suite is `npm run test:concurrency` and not part
// of the default `npm test`. The build plan's own check is that it takes more
// than a second; a fast run here would mean no container started.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { PrismaClient } from '@prisma/client';

// Resolved rather than hardcoded, so a Prisma upgrade that moves its build
// output fails loudly here instead of silently skipping the migration.
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');

const POSTGRES_IMAGE = 'postgres:16-alpine';
const POSTGRES_PORT = 5432;
const DB_USER = 'zippy';
const DB_PASSWORD = 'zippy';
const DB_NAME = 'zippy_concurrency';

export type ConcurrencyHarness = {
  prisma: PrismaClient;
  databaseUrl: string;
  stop: () => Promise<void>;
};

export async function startPostgres(): Promise<ConcurrencyHarness> {
  const container: StartedTestContainer = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_USER: DB_USER,
      POSTGRES_PASSWORD: DB_PASSWORD,
      POSTGRES_DB: DB_NAME,
    })
    .withExposedPorts(POSTGRES_PORT)
    // "Ready" twice, deliberately: Postgres's entrypoint starts the server,
    // stops it to run init scripts, and starts it again, so the FIRST ready
    // line is a server that is about to go away. Waiting for one of them is
    // the classic flaky-container bug.
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(120_000)
    .start();

  const databaseUrl = `postgresql://${DB_USER}:${DB_PASSWORD}@${container.getHost()}:${container.getMappedPort(
    POSTGRES_PORT,
  )}/${DB_NAME}?schema=public`;

  // The REAL migrations, not `db push` from the schema. The append-only
  // triggers on job_events live in a migration file and not in schema.prisma,
  // so a pushed schema would be missing exactly the constraint these tests
  // most need to be real.
  // Prisma's CLI entrypoint run directly on this process's own node binary,
  // rather than through `npx`. `npx` needs a shell on Windows, and passing
  // arguments through a shell is deprecated (DEP0190) because they are
  // concatenated rather than escaped — with a database URL among the
  // environment, that is not a warning worth ignoring. Resolving the module
  // avoids the shell entirely and works the same on every platform.
  execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();

  return {
    prisma,
    databaseUrl,
    stop: async () => {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// The smallest fixture these tests can run against: enough rows for a unit to
// be held and a job to exist, and nothing else.

export type Fixture = {
  zoneId: string;
  jobIds: string[];
  unitIds: string[];
  technicianIds: string[];
};

export async function seedFixture(
  prisma: PrismaClient,
  options: { units: number; jobs: number; prefix: string },
): Promise<Fixture> {
  const { prefix } = options;
  const zoneId = `${prefix}-zone`;

  await prisma.zone.create({
    data: {
      id: zoneId,
      code: prefix.toUpperCase().slice(0, 8),
      name: `${prefix} zone`,
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });

  await prisma.tenant.create({
    data: { id: `${prefix}-tenant`, name: `${prefix} tenant`, kind: 'FLEET' },
  });

  await prisma.vehicleProfile.create({
    data: {
      id: `${prefix}-profile`,
      make: prefix.toUpperCase(),
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });

  await prisma.user.create({
    data: {
      id: `${prefix}-driver-user`,
      email: `${prefix}-driver@example.test`,
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Fixture Driver',
    },
  });
  await prisma.driver.create({
    data: { id: `${prefix}-driver`, userId: `${prefix}-driver-user`, tenantId: `${prefix}-tenant`, homeZoneId: zoneId },
  });
  await prisma.vehicle.create({
    data: {
      id: `${prefix}-vehicle`,
      driverId: `${prefix}-driver`,
      tenantId: `${prefix}-tenant`,
      profileId: `${prefix}-profile`,
      registration: `${prefix.toUpperCase().slice(0, 4)}0001`,
      colour: 'White',
    },
  });

  const technicianIds: string[] = [];
  for (let i = 0; i < options.units; i++) {
    const number = String(i + 1).padStart(3, '0');
    await prisma.user.create({
      data: {
        id: `${prefix}-tech-user-${number}`,
        email: `${prefix}-tech${number}@example.test`,
        passwordHash: 'not-used',
        role: 'TECHNICIAN',
        name: `Fixture Technician ${number}`,
      },
    });
    await prisma.technician.create({
      data: {
        id: `${prefix}-tech-${number}`,
        userId: `${prefix}-tech-user-${number}`,
        employeeCode: `${prefix}-EMP-${number}`,
        homeZoneId: zoneId,
        active: true,
      },
    });
    technicianIds.push(`${prefix}-tech-${number}`);
  }

  const unitIds: string[] = [];
  for (let i = 0; i < options.units; i++) {
    const number = String(i + 1).padStart(3, '0');
    await prisma.unit.create({
      data: {
        id: `${prefix}-unit-${number}`,
        code: `${prefix.toUpperCase()}-U${number}`,
        kind: 'VAN',
        zoneId,
        status: 'AVAILABLE',
        currentTechnicianId: technicianIds[i]!,
        lat: 12.9352,
        lng: 77.6245,
      },
    });
    unitIds.push(`${prefix}-unit-${number}`);
  }

  const jobIds: string[] = [];
  for (let i = 0; i < options.jobs; i++) {
    const number = String(i + 1).padStart(3, '0');
    await prisma.job.create({
      data: {
        id: `${prefix}-job-${number}`,
        tenantId: `${prefix}-tenant`,
        driverId: `${prefix}-driver`,
        vehicleId: `${prefix}-vehicle`,
        zoneId,
        status: 'PLANNED',
        lat: 12.9352,
        lng: 77.6245,
      },
    });
    jobIds.push(`${prefix}-job-${number}`);
  }

  return { zoneId, jobIds, unitIds, technicianIds };
}
