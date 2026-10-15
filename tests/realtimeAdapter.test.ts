// THE REDIS ADAPTER — proving a job event published from a process with no
// browser connected to it (the worker process; the simulator CLI) still
// reaches a socket connected to a DIFFERENT process's Server.
//
// Two OS processes cannot share one Node module registry, so this cannot
// spawn a literal second process — but it does not need to. The only thing
// that distinguishes "the web process" from "any other process" in this
// codebase is a single module-level reference in publish.ts (whether
// `setRealtimeServer` was ever called with a real `Server`). Setting it back
// to null while a real, adapter-wired `Server` is still alive and still
// subscribed on Redis is a faithful reproduction of a second process: from
// that moment, `publishJobEvents` can ONLY reach this socket by going out
// over Redis and back in through the adapter, exactly as it would from a
// worker process that never had a `Server` to begin with.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRealtimeServer, closeRealtimeAdapter } from '../src/realtime/server.js';
import { setRealtimeServer } from '../src/realtime/publish.js';
import type { JobEventMessage } from '../src/realtime/publish.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { createIntakeJob } from '../src/intake/createJob.js';
import { symptomPayloadSchema } from '../src/domain/symptoms.js';
import { safetyReportSchema } from '../src/domain/safety.js';
import { locationSchema } from '../src/domain/location.js';

const TENANT = 'ra-tenant';
const ZONE = 'ra-zone';

describe('cross-process delivery via the redis adapter', () => {
  let io: Server;
  let httpServer: ReturnType<typeof createServer>;
  let dispatcher: ClientSocket;
  const dispatcherEvents: JobEventMessage[] = [];

  beforeAll(async () => {
    await buildFixture();

    httpServer = createServer();
    io = createRealtimeServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;

    const token = issueAccessToken({
      sub: 'ra-dispatch-user',
      role: 'DISPATCHER',
      tenantId: null,
      crossTenant: true,
    });
    dispatcher = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    dispatcher.on('job:event', (event: JobEventMessage) => dispatcherEvents.push(event));

    await new Promise<void>((resolve, reject) => {
      dispatcher.on('connect', () => resolve());
      dispatcher.on('connect_error', reject);
    });

    // FROM HERE ON, THIS PROCESS BEHAVES LIKE THE WORKER PROCESS: no real
    // `Server` to hand a job event to, only the Redis fallback. `io` stays
    // alive and stays subscribed the whole time — it is standing in for the
    // web process, which never stops running while the worker publishes.
    setRealtimeServer(null);
  });

  afterAll(async () => {
    dispatcher.disconnect();
    await io.close();
    await closeRealtimeAdapter();
    await prismaBase.$disconnect();
  });

  it('delivers a job event published with no local Server to a socket on a different Server', async () => {
    const created = await createIntakeJob(prismaBase, intakeRequest());

    await waitFor(() => dispatcherEvents.some((event) => event.jobId === created.jobId), 4_000);

    const forThisJob = dispatcherEvents.filter((event) => event.jobId === created.jobId);
    expect(forThisJob.length).toBeGreaterThan(0);
    expect(forThisJob[0]?.eventType).toBe('JOB_CREATED');
  }, 8_000);
});

function intakeRequest() {
  return {
    driverId: 'ra-driver',
    vehicleId: 'ra-vehicle',
    tenantId: TENANT,
    symptoms: symptomPayloadSchema.parse({ primaryComplaint: 'FLAT_TYRE' }),
    safety: safetyReportSchema.parse({}),
    location: locationSchema.parse({ lat: 28.6152, lng: 77.2095, roadPosition: 'PARKING' }),
    actor: { role: 'DRIVER', id: 'ra-driver-user' },
    at: new Date('2026-06-01T09:00:00Z'),
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the job event to arrive');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Upserted, never torn down: job_events is append-only, so a job that has
// events cannot be deleted.
async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Realtime Adapter Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: ZONE },
    update: {},
    create: {
      id: ZONE,
      code: 'RAZ',
      name: 'Realtime Adapter Zone',
      city: 'Delhi',
      centroidLat: 28.6152,
      centroidLng: 77.2095,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: 'ra-profile' },
    update: {},
    create: {
      id: 'ra-profile',
      make: 'TEST_REALTIME_ADAPTER',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  await prismaBase.user.upsert({
    where: { id: 'ra-driver-user' },
    update: {},
    create: {
      id: 'ra-driver-user',
      email: 'ra-driver@example.test',
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Realtime Adapter Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: 'ra-driver' },
    update: {},
    create: { id: 'ra-driver', userId: 'ra-driver-user', tenantId: TENANT, homeZoneId: ZONE },
  });
  await prismaBase.vehicle.upsert({
    where: { id: 'ra-vehicle' },
    update: {},
    create: {
      id: 'ra-vehicle',
      driverId: 'ra-driver',
      tenantId: TENANT,
      profileId: 'ra-profile',
      registration: 'RA01AB0001',
      colour: 'White',
    },
  });
}
