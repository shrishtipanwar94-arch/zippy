// PHASE 18 — PARTS AND INVENTORY, and the phase check written down.
//
// The check is a reconciliation:
//   SELECT s.id, s.starting_qty + SUM(m.delta), s.quantity
//   FROM unit_stock s JOIN stock_movements m ON m.unit_stock_id = s.id
//   GROUP BY 1, 3;
//   -- computed = quantity for every row
// The last describe block below runs exactly that, over this file's own van,
// after the rest of the file has consumed, adjusted and replenished it.
//
// SCOPED TO THIS FILE'S OWN ROWS, and it has to be twice over. `zippy_test` is
// shared and vitest runs files in parallel, so every assertion here names this
// file's unit or this file's parts — the reconciliation included, which is a
// stronger claim scoped than it would be as a table sweep: it proves the
// arithmetic of the movements this test caused.
//
// AND SCOPED ACROSS RUNS. stock_movements is append-only, so nothing this file
// writes can be deleted afterwards and the van carries yesterday's ledger into
// today's run. Two things follow. Every movement id carries a per-run token,
// or the second run would replay the first one's ids and see REPLAYED where it
// expected APPLIED. And the fixture puts the van back to a known level with a
// REPLENISHED movement rather than by writing `quantity` directly — which is
// also the only way to do it that keeps the reconciliation true.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { stockConfidence } from '../src/domain/stockConfidence.js';
import { applyStockMovement } from '../src/commit/stockMovements.js';

const app = createApp();
const PREFIX = 'stocktest';
const TENANT = `${PREFIX}-tenant`;
const UNIT = `${PREFIX}-unit`;
const JOB = `${PREFIX}-job`;

// Three parts, one per behaviour, so the tests cannot disturb each other by
// sharing a shelf: the belt is consumed, the battery is run down to nothing,
// the bulb is counted.
const BELT = `${PREFIX}-part-belt`;
const BATTERY = `${PREFIX}-part-battery`;
const BULB = `${PREFIX}-part-bulb`;
const ABSENT = `${PREFIX}-part-alternator`; // in the catalogue, never on this van

const STARTING_LEVELS: Record<string, number> = { [BELT]: 3, [BATTERY]: 1, [BULB]: 2 };

// Every movement this run writes is prefixed with it, so a second run of the
// suite is a genuinely new set of taps rather than a replay of the last one.
const RUN = `run${Date.now()}`;

function technicianToken(technicianId = `${PREFIX}-tech`): string {
  return issueAccessToken({
    sub: `${PREFIX}-tech-user`,
    role: 'TECHNICIAN',
    tenantId: TENANT,
    crossTenant: false,
    actorId: technicianId,
  });
}

function dispatcherToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-dispatcher-user`,
    role: 'DISPATCHER',
    tenantId: TENANT,
    crossTenant: false,
  });
}

function driverToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-driver-user`,
    role: 'DRIVER',
    tenantId: TENANT,
    crossTenant: false,
    actorId: `${PREFIX}-driver`,
  });
}

async function declare(lines: { partId: string; quantity: number }[], declarationId: string) {
  return request(app)
    .post(`/jobs/${JOB}/parts-used`)
    .set('Authorization', `Bearer ${technicianToken()}`)
    .send({ declarationId, lines, eventTime: new Date().toISOString() });
}

async function quantityOf(partId: string): Promise<number> {
  const shelf = await prismaBase.unitStock.findUnique({
    where: { unitId_partId: { unitId: UNIT, partId } },
    select: { quantity: true },
  });
  return shelf?.quantity ?? 0;
}

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

// ---------------------------------------------------------------------------

describe('stock confidence is a pure function of two timestamps', () => {
  const thresholds = { verifiedUnderMinutes: 120, ageingUnderMinutes: 480 };
  const now = new Date('2026-09-01T12:00:00.000Z');

  it('reads a fresh count as VERIFIED and an old one as UNVERIFIED', () => {
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    expect(stockConfidence(minutesAgo(30), now, thresholds)).toBe('VERIFIED');
    expect(stockConfidence(minutesAgo(119), now, thresholds)).toBe('VERIFIED');
    expect(stockConfidence(minutesAgo(121), now, thresholds)).toBe('AGEING');
    expect(stockConfidence(minutesAgo(479), now, thresholds)).toBe('AGEING');
    expect(stockConfidence(minutesAgo(481), now, thresholds)).toBe('UNVERIFIED');
  });

  // The case the phase is actually about: a number nobody has ever checked is
  // not "probably fine because we seeded it".
  it('reads a shelf nobody has ever counted as UNVERIFIED', () => {
    expect(stockConfidence(null, now, thresholds)).toBe('UNVERIFIED');
  });

  // A phone with a wrong clock, not a fresher count.
  it('treats a confirmation from the future as just counted', () => {
    const later = new Date(now.getTime() + 90 * 60_000);
    expect(stockConfidence(later, now, thresholds)).toBe('VERIFIED');
  });
});

describe('the van stock screen', () => {
  it('shows what is on board and how believable it is', async () => {
    const response = await request(app)
      .get('/technician/stock')
      .set('Authorization', `Bearer ${technicianToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.unitId).toBe(UNIT);
    const belt = response.body.lines.find((line: { partId: string }) => line.partId === BELT);
    expect(belt.quantity).toBe(STARTING_LEVELS[BELT]);
    // Replenished by the fixture and never counted, so the confidence is the
    // honest one rather than the flattering one.
    expect(belt.confidence).toBe('UNVERIFIED');
    expect(belt.minutesSinceConfirmed).toBeNull();
    expect(response.body.summary.unverified).toBeGreaterThan(0);
  });

  // A DRIVER may read `job`. They may not read a van.
  it('keeps a driver off the van entirely', async () => {
    const response = await request(app)
      .get('/technician/stock')
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(response.status).toBe(403);
  });

  // "May I see my own van" and "may I see any van" are different resources.
  // A technician holds the first and not the second.
  it('lets a dispatcher read any van and a technician read only their own', async () => {
    const asDispatcher = await request(app)
      .get(`/units/${UNIT}/stock`)
      .set('Authorization', `Bearer ${dispatcherToken()}`);
    expect(asDispatcher.status).toBe(200);
    expect(asDispatcher.body.unitCode).toBe('STK-VAN-1');

    const asTechnician = await request(app)
      .get(`/units/${UNIT}/stock`)
      .set('Authorization', `Bearer ${technicianToken()}`);
    expect(asTechnician.status).toBe(403);
  });
});

describe('declaring what was fitted', () => {
  it('decrements once, and writes the movement and the job event', async () => {
    const before = await quantityOf(BELT);
    const declarationId = `${RUN}-belt-once`;

    const response = await declare([{ partId: BELT, quantity: 1 }], declarationId);
    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('RECORDED');
    expect(response.body.lines[0].outcome).toBe('APPLIED');
    expect(await quantityOf(BELT)).toBe(before - 1);

    const movement = await prismaBase.stockMovement.findUniqueOrThrow({
      where: { id: `${declarationId}:${BELT}` },
      select: { delta: true, reason: true, jobId: true, unitId: true },
    });
    expect(movement).toMatchObject({ delta: -1, reason: 'CONSUMED', jobId: JOB, unitId: UNIT });

    const events = await prismaBase.jobEvent.count({
      where: { jobId: JOB, eventType: 'PARTS_CONSUMED' },
    });
    expect(events).toBeGreaterThan(0);
  });

  // THE ONE THE PHASE NAMES. "A double tap, or an offline replay, decrements
  // once." Same declaration id, so the same movement ids, so a primary-key
  // collision that takes the whole transaction down with it.
  it('decrements once however many times the same tap arrives', async () => {
    const before = await quantityOf(BELT);
    const declarationId = `${RUN}-belt-double`;

    const first = await declare([{ partId: BELT, quantity: 1 }], declarationId);
    expect(first.body.outcome).toBe('RECORDED');

    const second = await declare([{ partId: BELT, quantity: 1 }], declarationId);
    const third = await declare([{ partId: BELT, quantity: 1 }], declarationId);
    expect(second.body.outcome).toBe('REPLAYED');
    expect(third.body.outcome).toBe('REPLAYED');

    expect(await quantityOf(BELT)).toBe(before - 1);
    const movements = await prismaBase.stockMovement.count({
      where: { id: { startsWith: `${declarationId}:` } },
    });
    expect(movements).toBe(1);
  });

  // FAIL CLOSED. A van cannot hold minus one of anything, and a declaration
  // that would take it there means the count was already wrong.
  it('refuses to take more than is on board, and writes nothing', async () => {
    const before = await quantityOf(BELT);
    const response = await declare(
      [{ partId: BELT, quantity: before + 5 }],
      `${RUN}-belt-too-many`,
    );

    expect(response.body.lines[0].outcome).toBe('REJECTED');
    expect(response.body.lines[0].detail).toContain(`only ${before}`);
    expect(await quantityOf(BELT)).toBe(before);
  });

  it('refuses a part this van does not carry', async () => {
    const response = await declare([{ partId: ABSENT, quantity: 1 }], `${RUN}-absent`);
    expect(response.body.lines[0].outcome).toBe('REJECTED');
    expect(response.body.lines[0].detail).toContain('does not carry');

    const shelf = await prismaBase.unitStock.findUnique({
      where: { unitId_partId: { unitId: UNIT, partId: ABSENT } },
    });
    expect(shelf).toBeNull();
  });

  // An empty van is a degraded van, and invariant 8 says a degraded state is
  // visible to an operator. The restock request is that visibility.
  it('raises a restock request when the last one comes off the shelf', async () => {
    expect(await quantityOf(BATTERY)).toBe(1);
    const response = await declare([{ partId: BATTERY, quantity: 1 }], `${RUN}-battery-last`);
    expect(response.body.lines[0].outcome).toBe('APPLIED');
    expect(await quantityOf(BATTERY)).toBe(0);

    const orders = await prismaBase.restockOrder.findMany({
      where: { unitId: UNIT, partId: BATTERY, status: 'REQUESTED' },
      select: { quantity: true },
    });
    expect(orders).toHaveLength(1);
  });

  it('refuses a declaration for a job that is not this technician\'s', async () => {
    const response = await request(app)
      .post(`/jobs/${JOB}/parts-used`)
      .set('Authorization', `Bearer ${technicianToken(`${PREFIX}-other-tech`)}`)
      .send({ declarationId: `${RUN}-stolen`, lines: [{ partId: BELT, quantity: 1 }] });
    expect(response.body.outcome).toBe('REJECTED');
    expect(response.body.detail).toContain('no longer assigned to you');
  });
});

describe('counting the van', () => {
  it('makes a shelf believable again, and says when', async () => {
    const response = await request(app)
      .post('/technician/stock/confirm')
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({
        confirmationId: `${RUN}-count-agrees`,
        counted: [{ partId: BULB, quantity: await quantityOf(BULB) }],
      });

    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('CONFIRMED');
    // The count agreed, so there is nothing to correct — but the shelf is
    // freshly confirmed all the same. That is the product of this action.
    expect(response.body.lines[0].adjustedBy).toBe(0);

    const screen = await request(app)
      .get('/technician/stock')
      .set('Authorization', `Bearer ${technicianToken()}`);
    const bulb = screen.body.lines.find((line: { partId: string }) => line.partId === BULB);
    expect(bulb.confidence).toBe('VERIFIED');
    expect(bulb.minutesSinceConfirmed).toBe(0);

    const evidence = await prismaBase.stockConfirmation.findUniqueOrThrow({
      where: { id: `${RUN}-count-agrees:${BULB}` },
      select: { unitId: true, quantity: true },
    });
    expect(evidence.unitId).toBe(UNIT);
  });

  // A correction is a MOVEMENT, never an overwrite. The ledger has to keep
  // explaining the number: "somebody found one fewer than we thought" is
  // exactly the row an audit wants.
  it('reconciles a count that disagrees with an ADJUSTED movement', async () => {
    const expected = await quantityOf(BULB);
    const response = await request(app)
      .post('/technician/stock/confirm')
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({
        confirmationId: `${RUN}-count-differs`,
        counted: [{ partId: BULB, quantity: expected - 1 }],
      });

    expect(response.body.lines[0]).toMatchObject({ expected, counted: expected - 1, adjustedBy: -1 });
    expect(await quantityOf(BULB)).toBe(expected - 1);

    const movement = await prismaBase.stockMovement.findUniqueOrThrow({
      where: { id: `${RUN}-count-differs:${BULB}` },
      select: { delta: true, reason: true, jobId: true },
    });
    expect(movement).toMatchObject({ delta: -1, reason: 'ADJUSTED', jobId: null });
  });

  it('records one count however many times the same tap arrives', async () => {
    const body = {
      confirmationId: `${RUN}-count-double`,
      counted: [{ partId: BULB, quantity: 0 }],
    };
    const first = await request(app)
      .post('/technician/stock/confirm')
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send(body);
    const second = await request(app)
      .post('/technician/stock/confirm')
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send(body);

    expect(first.body.outcome).toBe('CONFIRMED');
    expect(second.body.outcome).toBe('REPLAYED');
    expect(await quantityOf(BULB)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE PHASE CHECK.

describe('the ledger explains every quantity', () => {
  it('reconciles starting_qty + SUM(delta) against quantity, for this van', async () => {
    const rows = await prismaBase.$queryRaw<
      { id: string; computed: bigint; quantity: number }[]
    >`
      SELECT s.id,
             s.starting_qty + COALESCE(SUM(m.delta), 0) AS computed,
             s.quantity
      FROM unit_stock s
      LEFT JOIN stock_movements m ON m.unit_stock_id = s.id
      WHERE s.unit_id = ${UNIT}
      GROUP BY s.id, s.starting_qty, s.quantity
    `;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.computed)).toBe(row.quantity);
    }
  });

  // The ledger is only worth anything if nobody can quietly rewrite it. Same
  // rule, same trigger function, as job_events and ledger_entries.
  it('refuses an UPDATE on a movement', async () => {
    const movement = await prismaBase.stockMovement.findFirstOrThrow({
      where: { unitId: UNIT },
      select: { id: true },
    });
    await expect(
      prismaBase.$executeRaw`UPDATE stock_movements SET delta = 0 WHERE id = ${movement.id}`,
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------

// One van, three shelves, put back to a known level with REPLENISHED movements
// rather than by writing `quantity` — the same path production uses, and the
// only one that leaves the reconciliation above true.
async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Stock Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'STK',
      name: 'Stock Zone',
      city: 'Delhi',
      centroidLat: 28.6152,
      centroidLng: 77.2095,
    },
  });

  for (const suffix of ['tech', 'other-tech']) {
    await prismaBase.user.upsert({
      where: { id: `${PREFIX}-${suffix}-user` },
      update: {},
      create: {
        id: `${PREFIX}-${suffix}-user`,
        email: `${PREFIX}-${suffix}@example.test`,
        passwordHash: 'not-used',
        role: 'TECHNICIAN',
        name: 'Meera Nair',
      },
    });
    await prismaBase.technician.upsert({
      where: { id: `${PREFIX}-${suffix}` },
      update: {},
      create: {
        id: `${PREFIX}-${suffix}`,
        userId: `${PREFIX}-${suffix}-user`,
        employeeCode: `${PREFIX}-${suffix}`,
        homeZoneId: `${PREFIX}-zone`,
      },
    });
  }

  // OFFLINE, and with no capabilities. `buildDispatchSnapshot` reads the WHOLE
  // fleet, so a van left behind by this file must never be a candidate in
  // somebody else's solve — feasibility rejects any unit that is not AVAILABLE.
  await prismaBase.unit.upsert({
    where: { id: UNIT },
    update: { currentTechnicianId: `${PREFIX}-tech`, status: 'OFFLINE' },
    create: {
      id: UNIT,
      code: 'STK-VAN-1',
      kind: 'VAN',
      zoneId: `${PREFIX}-zone`,
      status: 'OFFLINE',
      currentTechnicianId: `${PREFIX}-tech`,
      lat: 28.62,
      lng: 77.205,
    },
  });

  await prismaBase.partCategory.upsert({
    where: { code: `${PREFIX}-CAT` },
    update: {},
    create: { id: `${PREFIX}-cat`, code: `${PREFIX}-CAT`, name: 'Stock Test Parts' },
  });
  const catalogue = [
    { id: BELT, sku: `${PREFIX}-BELT`, name: 'Stock test drive belt' },
    { id: BATTERY, sku: `${PREFIX}-BATTERY`, name: 'Stock test battery' },
    { id: BULB, sku: `${PREFIX}-BULB`, name: 'Stock test bulb' },
    { id: ABSENT, sku: `${PREFIX}-ALT`, name: 'Stock test alternator' },
  ];
  for (const part of catalogue) {
    await prismaBase.part.upsert({
      where: { id: part.id },
      update: {},
      create: { id: part.id, sku: part.sku, name: part.name, categoryId: `${PREFIX}-cat` },
    });
  }

  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-driver-user` },
    update: {},
    create: {
      id: `${PREFIX}-driver-user`,
      email: `${PREFIX}-driver@example.test`,
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Fixture Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: `${PREFIX}-driver` },
    update: {},
    create: { id: `${PREFIX}-driver`, userId: `${PREFIX}-driver-user`, tenantId: TENANT },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${PREFIX}-profile` },
    update: {},
    create: {
      id: `${PREFIX}-profile`,
      make: 'Tata',
      model: 'Nexon',
      yearFrom: 2021,
      yearTo: 2026,
      bodyType: 'SUV',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  await prismaBase.vehicle.upsert({
    where: { id: `${PREFIX}-vehicle` },
    update: {},
    create: {
      id: `${PREFIX}-vehicle`,
      driverId: `${PREFIX}-driver`,
      tenantId: TENANT,
      profileId: `${PREFIX}-profile`,
      registration: 'DL01ST0001',
      colour: 'Blue',
    },
  });

  // ON_SITE, because "I fitted these" is only a sentence that makes sense once
  // somebody has opened the bonnet. Dated in the past — a future-dated fixture
  // squats forever on the fifty-newest list GET /jobs returns.
  await prismaBase.job.upsert({
    where: { id: JOB },
    update: { status: 'ON_SITE', assignedUnitId: UNIT, assignedTechnicianId: `${PREFIX}-tech` },
    create: {
      id: JOB,
      tenantId: TENANT,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      status: 'ON_SITE',
      safetyLevel: 'NORMAL',
      assignedUnitId: UNIT,
      assignedTechnicianId: `${PREFIX}-tech`,
      lat: 28.6152,
      lng: 77.2095,
      roadPosition: 'SERVICE_ROAD',
      createdAt: new Date('2026-08-01T09:00:00.000Z'),
    },
  });

  for (const [partId, target] of Object.entries(STARTING_LEVELS)) {
    await topUpTo(partId, target);
  }
}

// Puts one shelf at `target` by REPLENISHING the difference. Never by writing
// `quantity`: this file's last assertion is that the ledger explains the
// number, and a fixture that set it directly would be the one thing capable of
// making that assertion false.
async function topUpTo(partId: string, target: number): Promise<void> {
  const current = await quantityOf(partId);
  // The count is also reset, so a shelf confirmed by yesterday's run does not
  // start today's already VERIFIED.
  await prismaBase.unitStock.updateMany({
    where: { unitId: UNIT, partId },
    data: { confirmedAt: null },
  });
  if (current === target) return;

  await prismaBase.$transaction((tx) =>
    applyStockMovement(tx, {
      movementId: `${RUN}-topup-${partId}`,
      unitId: UNIT,
      partId,
      delta: target - current,
      reason: target > current ? 'REPLENISHED' : 'ADJUSTED',
      eventTime: new Date(),
    }),
  );
}
