// The Socket.IO layer: the room rules on their own, then a real server on a
// real port with real clients, against the real `zippy_test` Postgres.
//
// The handshake tests are the ones that matter. "JWT verified on the handshake"
// is only true if a connection WITHOUT a valid token never becomes a socket —
// so these assert the connection is refused, not that some later message is
// rejected.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRealtimeServer } from '../src/realtime/server.js';
import { setRealtimeServer } from '../src/realtime/publish.js';
import {
  jobRoom,
  mayRequestJobRoom,
  roomsForJobEvent,
  standingRoomsFor,
  technicianRoom,
  technicianRoomForEvent,
  tenantRoom,
  zoneRoom,
} from '../src/realtime/rooms.js';
import type { AuthContext } from '../src/auth/context.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { createIntakeJob } from '../src/intake/createJob.js';
import { symptomPayloadSchema } from '../src/domain/symptoms.js';
import { safetyReportSchema } from '../src/domain/safety.js';
import { locationSchema } from '../src/domain/location.js';
import type { JobEventMessage } from '../src/realtime/publish.js';
import { replayJobEvents } from '../src/realtime/replay.js';
import type { ReplayResult } from '../src/realtime/replay.js';

const TENANT = 'rt-tenant';
const ZONE = 'rt-zone';

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'rt-user',
    role: 'DRIVER',
    tenantId: TENANT,
    crossTenant: false,
    ...overrides,
  };
}

describe('room rules', () => {
  it('names the three room types distinctly', () => {
    expect(jobRoom('j1')).toBe('job:j1');
    expect(zoneRoom('z1')).toBe('zone:z1');
    expect(tenantRoom('t1')).toBe('tenant:t1');
  });

  it('puts a dispatcher in every zone and a fleet manager in their tenant', () => {
    const zones = ['zone-a', 'zone-b'];

    expect(standingRoomsFor(context({ role: 'DISPATCHER', tenantId: null, crossTenant: true }), zones))
      .toEqual(['zone:zone-a', 'zone:zone-b']);
    expect(standingRoomsFor(context({ role: 'FLEET_MANAGER' }), zones)).toEqual([
      `tenant:${TENANT}`,
    ]);
  });

  // A driver's interest is per-job and changes over the life of the connection,
  // so they get no standing room and must subscribe explicitly — which is what
  // forces every job room they enter through a database authorisation check.
  it('gives a driver no standing rooms', () => {
    expect(standingRoomsFor(context({ role: 'DRIVER' }), ['zone-a'])).toEqual([]);
  });

  // A TECHNICIAN IS THE EXCEPTION, and it is not a convenience. Their first
  // contact with a job is an offer that lives forty-five seconds, and until it
  // arrives they have no business in that job's room. Without a standing room
  // the first offer for any job reached nobody: not in the room, so no event,
  // so no refetch, and the page has no polling behind it. Every first offer
  // expired unseen.
  it('gives a technician their own standing room', () => {
    expect(standingRoomsFor(context({ role: 'TECHNICIAN', actorId: 'tech-01' }), ['zone-a']))
      .toEqual(['technician:tech-01']);
  });

  it('gives a technician with no actor id nothing rather than a room nobody owns', () => {
    expect(standingRoomsFor(context({ role: 'TECHNICIAN', actorId: undefined }), ['zone-a']))
      .toEqual([]);
  });

  it('routes an offer to the named technician and nothing else to anybody', () => {
    expect(technicianRoomForEvent('TECHNICIAN_OFFER_SENT', { technicianId: 'tech-07' })).toBe(
      technicianRoom('tech-07'),
    );
    // A short named list, not "anything carrying a technicianId": once the job
    // is theirs they are in its room and hear everything through that.
    expect(technicianRoomForEvent('DISPATCH_COMMITTED', { technicianId: 'tech-07' })).toBeNull();
    expect(technicianRoomForEvent('TECHNICIAN_OFFER_SENT', {})).toBeNull();
    expect(technicianRoomForEvent('TECHNICIAN_OFFER_SENT', null)).toBeNull();
  });

  it('gives a fleet manager with no tenant nothing rather than everything', () => {
    expect(standingRoomsFor(context({ role: 'FLEET_MANAGER', tenantId: null }), ['z'])).toEqual([]);
  });

  it('fans one event out to the job, zone and tenant rooms', () => {
    expect(roomsForJobEvent({ id: 'j1', zoneId: 'z1', tenantId: 't1' })).toEqual([
      'job:j1',
      'zone:z1',
      'tenant:t1',
    ]);
  });

  it('omits the tenant room for a walk-in job that has no tenant', () => {
    expect(roomsForJobEvent({ id: 'j1', zoneId: 'z1', tenantId: null })).toEqual([
      'job:j1',
      'zone:z1',
    ]);
  });

  it('lets every role ask for a job room — the row check decides, not the role', () => {
    for (const role of ['DRIVER', 'TECHNICIAN', 'DISPATCHER', 'FLEET_MANAGER'] as const) {
      expect(mayRequestJobRoom(role)).toBe(true);
    }
  });
});

describe('socket server', () => {
  let io: Server;
  let url: string;
  let httpServer: ReturnType<typeof createServer>;
  const clients: ClientSocket[] = [];

  function client(token?: string): ClientSocket {
    const socket = connect(url, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(socket);
    return socket;
  }

  function connected(socket: ClientSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', (error) => reject(error));
    });
  }

  beforeAll(async () => {
    await buildFixture();

    httpServer = createServer();
    io = createRealtimeServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const socket of clients) socket.disconnect();
    setRealtimeServer(null);
    await io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prismaBase.$disconnect();
  });

  it('refuses a connection with no token', async () => {
    await expect(connected(client())).rejects.toThrow('missing_token');
  });

  it('refuses a connection with a forged token', async () => {
    await expect(connected(client('not.a.jwt'))).rejects.toThrow('invalid_token');
  });

  it('accepts a connection with a valid access token', async () => {
    const token = issueAccessToken({
      sub: 'rt-driver-user',
      role: 'DRIVER',
      tenantId: TENANT,
      crossTenant: false,
      actorId: 'rt-driver',
    });

    const socket = client(token);
    await expect(connected(socket)).resolves.toBeUndefined();
    expect(socket.connected).toBe(true);
  });

  it('refuses a job subscription for a job the caller cannot see', async () => {
    const token = issueAccessToken({
      sub: 'rt-other-user',
      role: 'DRIVER',
      tenantId: TENANT,
      crossTenant: false,
      // A real driver, but not the one who raised the job.
      actorId: 'rt-other-driver',
    });

    const socket = client(token);
    await connected(socket);

    const jobId = await seedJob();
    const result = await socket.emitWithAck('job:subscribe', { jobId });
    expect(result).toEqual({ ok: false });
  });

  it('delivers a job event to the job, zone and tenant rooms, once each', async () => {
    const driverToken = issueAccessToken({
      sub: 'rt-driver-user',
      role: 'DRIVER',
      tenantId: TENANT,
      crossTenant: false,
      actorId: 'rt-driver',
    });
    const dispatcherToken = issueAccessToken({
      sub: 'rt-dispatch-user',
      role: 'DISPATCHER',
      tenantId: null,
      crossTenant: true,
    });

    const driver = client(driverToken);
    const dispatcher = client(dispatcherToken);
    await Promise.all([connected(driver), connected(dispatcher)]);

    // The dispatcher joins every zone room at connect and never subscribes to
    // the job, so what it receives proves the zone fan-out on its own.
    const dispatcherEvents: JobEventMessage[] = [];
    dispatcher.on('job:event', (event: JobEventMessage) => dispatcherEvents.push(event));

    const created = await createIntakeJob(prismaBase, intakeRequest());

    const subscribed = await driver.emitWithAck('job:subscribe', { jobId: created.jobId });
    expect(subscribed).toEqual({ ok: true });

    await waitFor(() => dispatcherEvents.length >= 6);

    // The whole intake, in sequence order, with no duplicates from the
    // dispatcher sitting in more than one room that matches. A flat tyre is
    // already certain enough to dispatch on, so intake completes without
    // asking anything and INTAKE_COMPLETED is the sixth event.
    const forThisJob = dispatcherEvents.filter((event) => event.jobId === created.jobId);
    expect(forThisJob.map((event) => event.eventType)).toEqual([
      'JOB_CREATED',
      'SYMPTOMS_CAPTURED',
      'SAFETY_TRIAGED',
      'LOCATION_CAPTURED',
      'FAULT_HYPOTHESIS_UPDATED',
      'INTAKE_COMPLETED',
    ]);
    expect(forThisJob.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('reconnect replay', () => {
  let jobId: string;

  beforeAll(async () => {
    await buildFixture();
    jobId = await seedJob();
  });

  afterAll(async () => {
    await prismaBase.$disconnect();
  });

  // A flat-tyre intake writes exactly six events, so the expected tail after
  // any cursor is arithmetic rather than a guess.
  it('replays everything after the cursor, in order', async () => {
    const replay = await replayJobEvents(jobId, 3);

    expect(replay.events.map((event) => event.sequence)).toEqual([4, 5, 6]);
    expect(replay.throughSequence).toBe(6);
    expect(replay.truncated).toBe(false);
  });

  it('replays the whole history for a client that has nothing', async () => {
    const replay = await replayJobEvents(jobId, 0);

    expect(replay.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(replay.events[0]?.eventType).toBe('JOB_CREATED');
  });

  it('replays nothing for a client that is already current', async () => {
    const replay = await replayJobEvents(jobId, 6);

    expect(replay.events).toEqual([]);
    expect(replay.throughSequence).toBe(6);
    expect(replay.truncated).toBe(false);
  });

  // Feeding a long-absent client a partial tail would leave it confidently
  // wrong. It is told to resync instead, and gets no events at all.
  it('refuses to replay a partial history and says so', async () => {
    const replay = await replayJobEvents(jobId, 0, 2);

    expect(replay.truncated).toBe(true);
    expect(replay.events).toEqual([]);
    expect(replay.throughSequence).toBe(0);
  });

  it('carries the payload and timestamp through unchanged', async () => {
    const replay = await replayJobEvents(jobId, 0);
    const created = replay.events[0]!;

    expect(created.jobId).toBe(jobId);
    expect(typeof created.at).toBe('string');
    expect(created.payload).toMatchObject({ zoneId: expect.any(String) });
  });
});

describe('reconnect over a live socket', () => {
  let io: Server;
  let httpServer: ReturnType<typeof createServer>;
  let url: string;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    await buildFixture();
    httpServer = createServer();
    io = createRealtimeServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const socket of clients) socket.disconnect();
    setRealtimeServer(null);
    await io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prismaBase.$disconnect();
  });

  // The scenario the cursor exists for: a client is subscribed, drops, events
  // happen while it is away, and it comes back saying how far it got.
  it('a client that reconnects with a cursor is sent what it missed', async () => {
    const token = issueAccessToken({
      sub: 'rt-driver-user',
      role: 'DRIVER',
      tenantId: TENANT,
      crossTenant: false,
      actorId: 'rt-driver',
    });

    const created = await createIntakeJob(prismaBase, intakeRequest());

    const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });

    const replays: ReplayResult[] = [];
    socket.on('job:replay', (replay: ReplayResult) => replays.push(replay));

    // Says it has applied up to sequence 2 — it dropped after LOCATION_CAPTURED
    // had not yet arrived.
    const ack = await socket.emitWithAck('job:subscribe', {
      jobId: created.jobId,
      lastEventSequence: 2,
    });
    expect(ack).toEqual({ ok: true });

    await waitFor(() => replays.length > 0);
    expect(replays[0]?.events.map((event) => event.sequence)).toEqual([3, 4, 5, 6]);
    expect(replays[0]?.jobId).toBe(created.jobId);
  });

  it('sends no replay at all when the client omits a cursor', async () => {
    const token = issueAccessToken({
      sub: 'rt-driver-user',
      role: 'DRIVER',
      tenantId: TENANT,
      crossTenant: false,
      actorId: 'rt-driver',
    });

    const created = await createIntakeJob(prismaBase, intakeRequest());
    const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });

    const replays: ReplayResult[] = [];
    socket.on('job:replay', (replay: ReplayResult) => replays.push(replay));

    await socket.emitWithAck('job:subscribe', { jobId: created.jobId });
    // A first subscribe is not a reconnect; there is nothing to catch up on.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(replays).toEqual([]);
  });

  it('refuses a malformed cursor rather than guessing what it meant', async () => {
    const token = issueAccessToken({
      sub: 'rt-driver-user',
      role: 'DRIVER',
      tenantId: TENANT,
      crossTenant: false,
      actorId: 'rt-driver',
    });

    const created = await createIntakeJob(prismaBase, intakeRequest());
    const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });

    for (const cursor of [-1, 1.5, 'three', null]) {
      const ack = await socket.emitWithAck('job:subscribe', {
        jobId: created.jobId,
        lastEventSequence: cursor,
      });
      expect(ack, `cursor ${String(cursor)}`).toEqual({ ok: false });
    }

    // The bare string form is gone: there is one way to subscribe.
    expect(await socket.emitWithAck('job:subscribe', created.jobId)).toEqual({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Fixture. A tenant, a zone, a driver with a vehicle, and a second driver used
// to prove a job subscription is refused across owners.
//
// NOTHING IS TORN DOWN, and that is forced by the schema rather than laziness.
// `job_events` is append-only, enforced by a database trigger from the Phase 1
// migration, so deleting a job — which cascades to its events — is rejected
// with "append-only table job_events: DELETE is not permitted". A job that has
// events cannot be removed at all. So the fixture upserts instead, and every
// assertion is scoped to the job id the test itself created; leftover jobs from
// earlier runs are inert.

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Realtime Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: ZONE },
    update: {},
    create: {
      id: ZONE,
      code: 'RTZ',
      name: 'Realtime Zone',
      city: 'Delhi',
      centroidLat: 28.6152,
      centroidLng: 77.2095,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: 'rt-profile' },
    update: {},
    create: {
      id: 'rt-profile',
      // Distinct from every other suite: the unique key is
      // (make, model, yearFrom, yearTo) and the suites share one database.
      make: 'TEST_REALTIME',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });

  for (const suffix of ['driver', 'other-driver']) {
    await prismaBase.user.upsert({
      where: { id: `rt-${suffix}-user` },
      update: {},
      create: {
        id: `rt-${suffix}-user`,
        email: `rt-${suffix}@example.test`,
        passwordHash: 'not-used',
        role: 'DRIVER',
        name: suffix,
      },
    });
    await prismaBase.driver.upsert({
      where: { id: `rt-${suffix}` },
      update: {},
      create: {
        id: `rt-${suffix}`,
        userId: `rt-${suffix}-user`,
        tenantId: TENANT,
        homeZoneId: ZONE,
      },
    });
  }

  await prismaBase.vehicle.upsert({
    where: { id: 'rt-vehicle' },
    update: {},
    create: {
      id: 'rt-vehicle',
      driverId: 'rt-driver',
      tenantId: TENANT,
      profileId: 'rt-profile',
      registration: 'RT01AB0001',
      colour: 'White',
    },
  });
}

function intakeRequest() {
  return {
    driverId: 'rt-driver',
    vehicleId: 'rt-vehicle',
    tenantId: TENANT,
    symptoms: symptomPayloadSchema.parse({ primaryComplaint: 'FLAT_TYRE' }),
    safety: safetyReportSchema.parse({}),
    location: locationSchema.parse({ lat: 28.6152, lng: 77.2095 }),
    actor: { role: 'DRIVER', id: 'rt-driver-user' },
    at: new Date('2026-06-01T09:00:00Z'),
  };
}

async function seedJob(): Promise<string> {
  const created = await createIntakeJob(prismaBase, intakeRequest());
  return created.jobId;
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for socket events');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
