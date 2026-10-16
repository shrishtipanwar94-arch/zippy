/**
 * ONE FAULT, THE WHOLE WAY: driver reports it -> dispatcher executes the card
 * -> crew B sees the offer -> cleaned up again.
 *
 * Every step goes through the real HTTP routes of an in-process app
 * (createApp + supertest) with real tokens from POST /auth/login, so this is
 * the path the three browser windows take, not a shortcut around it. Used by
 * scripts/demo-dry-check.ts; needs DEMO_MODE=true, because the dispatch card
 * after intake is a demo-mode behaviour (src/demo/demoDispatch.ts).
 *
 * CLEAN-UP LEAVES NO LIVE JOB. B declines through the technician route (which
 * unwinds the reservation and frees the van the normal way), then the job is
 * retired — CANCELLED with an event, never deleted (src/demo/retireDemoJob.ts).
 */

import request from 'supertest';
import type { Express } from 'express';
import { prismaBase } from '../src/infra/prismaBase.js';
import { prisma } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import { queues, deadLetterQueue } from '../src/queues/queues.js';
import { sharedQueueConnection } from '../src/queues/connection.js';
import { closeRealtimeAdapter } from '../src/realtime/server.js';
import { retireDemoJob } from '../src/demo/retireDemoJob.js';
import { DEMO_CREWS, DEMO_DISPATCHER, DEMO_DRIVER, DEMO_DRIVER_LOCATION } from '../src/demo/demoCrews.js';
import type { FaultScenario } from '../src/demo/faultScenarios.js';

const MAX_QUESTIONS = 12;

export type JourneyResult = {
  fault: string;
  jobId: string | null;
  // What intake actually concluded after the follow-up questions.
  topFault: string | null;
  // The crew the dispatch card names.
  cardCrew: string | null;
  // Whether crew B's own screen query (GET /technician/work) shows the offer.
  offerSeenByB: boolean;
  // How many jobs the dispatcher's GET /jobs returned while this one was live.
  dispatcherJobCount: number | null;
  // Set when the job hit a limit the product itself documents, rather than a
  // demo-board failure (the tow; see scripts/demo-dry-check.ts).
  knownLimitation: string | null;
  problem: string | null;
};

type Tokens = { driver: string; dispatcher: string; technician: string };

async function signIn(app: Express, email: string, password: string): Promise<string> {
  const response = await request(app).post('/auth/login').send({ email, password });
  if (response.status !== 200) throw new Error(`sign-in refused for ${email} (${response.status})`);
  return response.body.accessToken as string;
}

export async function signInDemoAccounts(app: Express, password: string): Promise<Tokens> {
  const crewB = DEMO_CREWS.find((crew) => crew.label === 'B')!;
  return {
    driver: await signIn(app, DEMO_DRIVER.email, password),
    dispatcher: await signIn(app, DEMO_DISPATCHER.email, password),
    technician: await signIn(app, crewB.email, password),
  };
}

function crewLabel(unitId: string | undefined): string | null {
  const crew = DEMO_CREWS.find((candidate) => candidate.unitId === unitId);
  return crew ? crew.label : unitId ?? null;
}

// Report the breakdown and answer every follow-up with its first offered
// answer until intake says it has enough. Returns the job id and top fault.
async function report(app: Express, token: string, scenario: FaultScenario): Promise<{ jobId: string; topFault: string }> {
  const vehicles = await request(app).get('/vehicles').set('Authorization', `Bearer ${token}`);
  const vehicle = (vehicles.body.vehicles as { id: string; registration: string }[]).find(
    (candidate) => candidate.registration === DEMO_DRIVER.registration,
  );
  if (!vehicle) throw new Error('the demo driver has no demo vehicle');

  const created = await request(app)
    .post('/jobs/intake')
    .set('Authorization', `Bearer ${token}`)
    .send({
      vehicleId: vehicle.id,
      symptoms: scenario.answers,
      location: { lat: DEMO_DRIVER_LOCATION.lat, lng: DEMO_DRIVER_LOCATION.lng, landmark: 'dry check' },
    });
  if (created.status !== 201) throw new Error(`intake refused (${created.status}): ${JSON.stringify(created.body)}`);

  const jobId = created.body.jobId as string;
  let topFault = created.body.topFault as string;
  let next = created.body.next;
  for (let asked = 0; !next.done && asked < MAX_QUESTIONS; asked++) {
    const answered = await request(app)
      .post(`/jobs/${jobId}/answers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ questionCode: next.question.code, answer: next.question.answers[0].value });
    if (answered.status !== 201) throw new Error(`answer refused (${answered.status})`);
    topFault = answered.body.topFault;
    next = answered.body.next;
  }
  return { jobId, topFault };
}

export async function runJourney(app: Express, tokens: Tokens, scenario: FaultScenario): Promise<JourneyResult> {
  const result: JourneyResult = {
    fault: scenario.fault,
    jobId: null,
    topFault: null,
    cardCrew: null,
    offerSeenByB: false,
    dispatcherJobCount: null,
    knownLimitation: null,
    problem: null,
  };
  try {
    const { jobId, topFault } = await report(app, tokens.driver, scenario);
    result.jobId = jobId;
    result.topFault = topFault;

    const board = await request(app).get('/jobs').set('Authorization', `Bearer ${tokens.dispatcher}`);
    result.dispatcherJobCount = (board.body.jobs as unknown[]).length;

    const actions = await request(app).get('/actions').set('Authorization', `Bearer ${tokens.dispatcher}`);
    const card = (actions.body.actions as { id: string; jobId: string; kind: string; computedImpact: { to?: { unitId?: string } } }[])
      .find((candidate) => candidate.jobId === jobId && candidate.kind.startsWith('REASSIGN'));
    if (!card) throw new Error('no dispatch card was raised for the job');
    result.cardCrew = crewLabel(card.computedImpact.to?.unitId);

    const executed = await request(app)
      .post(`/actions/${card.id}/execute`)
      .set('Authorization', `Bearer ${tokens.dispatcher}`)
      .send({});
    // A TOW CANNOT BE DISPATCHED, by the product's own guard: its third leg
    // needs a workshop to confirm the destination and there is no workshop
    // counterparty in the system (src/commit/redispatch.ts, INTERVIEW.md
    // 15.44). Reported as a known limitation, not a demo-board failure.
    if (executed.body.saga?.outcome === 'DESTINATION_UNCONFIRMABLE') {
      result.knownLimitation = 'tow refused at Execute: no workshop counterparty to confirm a destination';
      return result;
    }
    if (executed.body.reserved !== true) throw new Error(`execute did not reserve: ${JSON.stringify(executed.body)}`);

    const work = await request(app).get('/technician/work').set('Authorization', `Bearer ${tokens.technician}`);
    const offers = (work.body.offers ?? []) as { offerId: string; jobId: string }[];
    const offer = offers.find((candidate) => candidate.jobId === jobId);
    result.offerSeenByB = offer !== undefined;

    if (offer) {
      await request(app)
        .post(`/technician/offers/${offer.offerId}/respond`)
        .set('Authorization', `Bearer ${tokens.technician}`)
        .send({ decision: 'DECLINED' });
    }
  } catch (error) {
    result.problem = error instanceof Error ? error.message : String(error);
  } finally {
    if (result.jobId) await retireDemoJob(prismaBase, result.jobId, 'demo dry check: cleaned up');
  }
  return result;
}

// EVERYTHING THE IN-PROCESS APP OPENED, closed, so the script can end on its
// own. Without this the queue and Redis connections keep Node's event loop
// alive and the dry check never exits — which looks exactly like a hang. The
// same list src/index.ts closes on shutdown, plus the queues the routes
// enqueue into.
export async function closeConnections(): Promise<void> {
  for (const queue of Object.values(queues)) await queue.close().catch(() => undefined);
  await deadLetterQueue.close().catch(() => undefined);
  await closeRealtimeAdapter().catch(() => undefined);
  sharedQueueConnection.disconnect();
  redis.disconnect();
  await prisma.$disconnect().catch(() => undefined);
}
