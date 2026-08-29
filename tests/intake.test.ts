// The four pure pieces of intake: the rule table that turns symptoms into a
// belief, the entropy calculation that decides what to ask next, the safety
// triage, and the location refinement.
//
// No database and no HTTP here on purpose. Every one of these is a pure
// function over plain objects, and that is the property worth protecting: the
// Phase 10 evaluation harness replays thousands of scenarios through them, so
// anything that reached for a clock, a connection or Math.random would make the
// harness non-reproducible and the measured numbers worthless.

import { describe, expect, it } from 'vitest';

import { FAULT_CODES, FAULT_PRIORS, capabilitiesForFault } from '../src/domain/faults.js';
import type { FaultCode, FaultDistribution } from '../src/domain/faults.js';
import { classifySymptoms } from '../src/domain/faultRules.js';
import { symptomPayloadSchema } from '../src/domain/symptoms.js';
import type { SymptomPayload } from '../src/domain/symptoms.js';
import { rankFaults, shannonEntropy, topFault } from '../src/domain/entropy.js';
import { INTAKE_QUESTIONS, answerLikelihood, findQuestion } from '../src/domain/questions.js';
import {
  ENTROPY_STOP_THRESHOLD_BITS,
  MAX_QUESTIONS,
  decideNextQuestion,
  expectedInformationGain,
  posteriorForAnswer,
  selectNextQuestion,
} from '../src/domain/questionSelection.js';
import { capabilitySetIsStable, requiredCapabilities } from '../src/domain/capabilitySet.js';
import { isNightAt, safetyContextSchema, triageSafety } from '../src/domain/safety.js';
import type { SafetyContext } from '../src/domain/safety.js';
import { carriagewayFromHeading, locationColumns, locationSchema } from '../src/domain/location.js';
import { distanceKm, nearestZone } from '../src/domain/geo.js';
import { createRandom } from '../src/sim/random.js';
import { answerAsDriver } from '../src/sim/driverAnswers.js';

function symptoms(overrides: Partial<SymptomPayload> = {}): SymptomPayload {
  return symptomPayloadSchema.parse({ primaryComplaint: 'UNKNOWN', ...overrides });
}

function sumOf(distribution: FaultDistribution): number {
  let total = 0;
  for (const fault of FAULT_CODES) total += distribution[fault];
  return total;
}

// Walks a whole intake to completion with a simulated driver who answers from
// the true fault. Returns how many questions it took and where it ended up.
function runIntake(payload: SymptomPayload, trueFault: FaultCode, seed: number) {
  const random = createRandom(seed);
  let distribution = classifySymptoms(payload);
  const asked: string[] = [];

  for (;;) {
    const step = decideNextQuestion(distribution, asked);
    if (step.kind === 'STOP') {
      return { questionsAsked: asked.length, distribution, stopReason: step.reason };
    }
    const answer = answerAsDriver(random, step.choice.question, trueFault);
    distribution = posteriorForAnswer(distribution, step.choice.question, answer);
    asked.push(step.choice.question.code);
  }
}

describe('symptom classification', () => {
  it('always returns a normalised distribution, whatever the driver says', () => {
    for (const complaint of ['WONT_START', 'FLAT_TYRE', 'LOCKED_OUT', 'UNKNOWN'] as const) {
      const distribution = classifySymptoms(symptoms({ primaryComplaint: complaint }));
      expect(sumOf(distribution)).toBeCloseTo(1, 10);
      for (const fault of FAULT_CODES) {
        expect(distribution[fault]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('a stated flat tyre is already near-certain and needs one capability', () => {
    const distribution = classifySymptoms(symptoms({ primaryComplaint: 'FLAT_TYRE' }));

    expect(topFault(distribution)).toBe('FLAT_TYRE');
    expect(shannonEntropy(distribution)).toBeLessThan(ENTROPY_STOP_THRESHOLD_BITS);
    expect(requiredCapabilities(distribution)).toEqual(['TYRE_CHANGE']);
  });

  it('a stated no-start is genuinely ambiguous — several faults survive', () => {
    const distribution = classifySymptoms(symptoms({ primaryComplaint: 'WONT_START' }));

    expect(shannonEntropy(distribution)).toBeGreaterThan(ENTROPY_STOP_THRESHOLD_BITS);
    // More than one plausible fault, and they do not all want the same van.
    const plausible = FAULT_CODES.filter((fault) => distribution[fault] > 0.1);
    expect(plausible.length).toBeGreaterThan(1);
    expect(capabilitySetIsStable(distribution)).toBe(false);
  });

  it('a cranking engine rules the batteries out and points at fuel', () => {
    const cranks = classifySymptoms(
      symptoms({ primaryComplaint: 'WONT_START', engineCranks: 'YES' }),
    );
    const silent = classifySymptoms(symptoms({ primaryComplaint: 'WONT_START', engineCranks: 'NO' }));

    expect(cranks.OUT_OF_FUEL).toBeGreaterThan(silent.OUT_OF_FUEL);
    expect(silent.FLAT_BATTERY).toBeGreaterThan(cranks.FLAT_BATTERY);
    expect(silent.FAILED_BATTERY).toBeGreaterThan(cranks.FAILED_BATTERY);
  });

  it('a temperature light drives the diagnosis to overheating', () => {
    const distribution = classifySymptoms(
      symptoms({ primaryComplaint: 'WARNING_LIGHT', warningLights: ['TEMPERATURE'] }),
    );

    expect(topFault(distribution)).toBe('ENGINE_OVERHEAT');
    expect(requiredCapabilities(distribution)).toContain('OBD_DIAGNOSTICS');
  });

  it('an uncharacterised complaint leaves the base rates alone', () => {
    const distribution = classifySymptoms(symptoms({ primaryComplaint: 'UNKNOWN' }));

    for (const fault of FAULT_CODES) {
      expect(distribution[fault]).toBeCloseTo(FAULT_PRIORS[fault], 10);
    }
  });

  it('the required capability set covers every fault still in contention', () => {
    const distribution = classifySymptoms(symptoms({ primaryComplaint: 'WONT_START' }));
    const required = requiredCapabilities(distribution);

    // Whatever the leading fault turns out to be, we are sending someone who
    // can fix it — being wrong here means a second callout.
    expect(required).toContain(capabilitiesForFault(topFault(distribution))[0]);
    expect(required.length).toBeGreaterThan(1);
  });

  it('is deterministic — the same payload twice gives the same belief', () => {
    const payload = symptoms({
      primaryComplaint: 'WONT_START',
      engineCranks: 'NO',
      warningLights: ['BATTERY'],
      unusualSound: 'CLICKING',
    });

    expect(classifySymptoms(payload)).toEqual(classifySymptoms(payload));
  });
});

describe('entropy-driven question selection', () => {
  it('every likelihood row in the catalogue sums to 1', () => {
    for (const question of INTAKE_QUESTIONS) {
      for (const fault of FAULT_CODES) {
        const row = question.likelihoods[fault];
        if (!row) continue;

        let total = 0;
        for (const answer of question.answers) total += row[answer] ?? 0;
        expect(total, `${question.code} / ${fault}`).toBeCloseTo(1, 6);
      }
    }
  });

  it('entropy is zero when certain and maximal when uniform', () => {
    const certain = {} as FaultDistribution;
    const uniform = {} as FaultDistribution;
    for (const fault of FAULT_CODES) {
      certain[fault] = fault === 'FLAT_TYRE' ? 1 : 0;
      uniform[fault] = 1 / FAULT_CODES.length;
    }

    expect(shannonEntropy(certain)).toBeCloseTo(0, 10);
    expect(shannonEntropy(uniform)).toBeCloseTo(Math.log2(FAULT_CODES.length), 10);
  });

  // The theorem the whole selector rests on. A single answer can surprise us and
  // leave us less sure, but the AVERAGE over the answers we might get never can.
  it('expected information gain is never negative, for any question or belief', () => {
    const beliefs = [
      classifySymptoms(symptoms({ primaryComplaint: 'WONT_START' })),
      classifySymptoms(symptoms({ primaryComplaint: 'UNKNOWN' })),
      classifySymptoms(symptoms({ primaryComplaint: 'FLAT_TYRE' })),
      classifySymptoms(
        symptoms({ primaryComplaint: 'WARNING_LIGHT', warningLights: ['EV_SYSTEM'] }),
      ),
    ];

    for (const belief of beliefs) {
      for (const question of INTAKE_QUESTIONS) {
        expect(expectedInformationGain(belief, question)).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it('picks the question with the highest expected gain, and never repeats one', () => {
    const belief = classifySymptoms(symptoms({ primaryComplaint: 'WONT_START' }));
    const best = selectNextQuestion(belief, []);
    expect(best).not.toBeNull();

    for (const question of INTAKE_QUESTIONS) {
      expect(expectedInformationGain(belief, question)).toBeLessThanOrEqual(
        best!.expectedGainBits + 1e-12,
      );
    }

    const second = selectNextQuestion(belief, [best!.question.code]);
    expect(second?.question.code).not.toBe(best!.question.code);
  });

  it('asks nothing for a flat tyre and several for a bare no-start', () => {
    const flatTyre = runIntake(symptoms({ primaryComplaint: 'FLAT_TYRE' }), 'FLAT_TYRE', 7);
    expect(flatTyre.questionsAsked).toBe(0);
    expect(flatTyre.stopReason).toBe('ENTROPY_BELOW_THRESHOLD');

    // The headline claim: question count tracks ambiguity, it is not a form
    // wizard. Averaged over seeds so one unlucky answer sequence cannot flip it.
    let total = 0;
    for (let seed = 1; seed <= 25; seed += 1) {
      total += runIntake(symptoms({ primaryComplaint: 'WONT_START' }), 'FLAT_BATTERY', seed)
        .questionsAsked;
    }
    expect(total / 25).toBeGreaterThan(1.5);
  });

  it('stops once every contending fault wants the same technician', () => {
    // A failing starter motor and an overheating engine both resolve to
    // OBD_DIAGNOSTICS, so telling them apart cannot change who gets sent and
    // intake has no reason to keep the driver on the phone.
    const belief = {} as FaultDistribution;
    for (const fault of FAULT_CODES) belief[fault] = 0;
    belief.STARTER_MOTOR = 0.55;
    belief.ENGINE_OVERHEAT = 0.45;

    expect(capabilitiesForFault('STARTER_MOTOR')).toEqual(capabilitiesForFault('ENGINE_OVERHEAT'));

    expect(shannonEntropy(belief)).toBeGreaterThan(ENTROPY_STOP_THRESHOLD_BITS);
    const step = decideNextQuestion(belief, []);
    expect(step).toEqual({ kind: 'STOP', reason: 'CAPABILITY_SET_STABLE' });
  });

  it('never interrogates a driver past the question cap', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const run = runIntake(symptoms({ primaryComplaint: 'UNKNOWN' }), 'IMMOBILISED_UNKNOWN', seed);
      expect(run.questionsAsked).toBeLessThanOrEqual(MAX_QUESTIONS);
    }
  });

  it('a posterior stays a probability distribution', () => {
    const belief = classifySymptoms(symptoms({ primaryComplaint: 'WONT_START' }));
    const question = findQuestion('STARTER_SOUND');
    expect(question).toBeDefined();

    for (const answer of question!.answers) {
      const posterior = posteriorForAnswer(belief, question!, answer);
      expect(sumOf(posterior)).toBeCloseTo(1, 10);
    }
  });

  it('a clicking starter promotes the batteries, exactly as the table says', () => {
    const belief = classifySymptoms(symptoms({ primaryComplaint: 'WONT_START' }));
    const question = findQuestion('STARTER_SOUND')!;
    const posterior = posteriorForAnswer(belief, question, 'CLICKING');

    expect(posterior.FLAT_BATTERY).toBeGreaterThan(belief.FLAT_BATTERY);
    expect(answerLikelihood(question, 'FLAT_BATTERY', 'CLICKING')).toBeGreaterThan(
      answerLikelihood(question, 'OUT_OF_FUEL', 'CLICKING'),
    );
    expect(rankFaults(posterior)[0]).toBe('FLAT_BATTERY');
  });

  // THE UNIFORM-DEFAULT RULE, and the bug it exists to prevent.
  //
  // A fault a question does not model must be UNIFORM across that question's
  // answers — every answer equally likely. Any other default (a
  // "normal-looking" row saying NO/SILENCE/HAS_FUEL is probable) quietly
  // promotes every fault the question forgot to mention, every single time a
  // driver reports nothing unusual. That bug was in this file once and it made
  // a stuck vehicle look like a flat tyre.
  it('a question is uninformative about a fault it does not model', () => {
    const question = findQuestion('FUEL_GAUGE')!;
    // FUEL_GAUGE models neither of these.
    for (const fault of ['BRAKE_FAILURE', 'IMMOBILISED_UNKNOWN'] as const) {
      expect(question.likelihoods[fault]).toBeUndefined();

      let total = 0;
      const first = answerLikelihood(question, fault, question.answers[0]!);
      for (const answer of question.answers) {
        // Flat: no answer is more expected than any other.
        expect(answerLikelihood(question, fault, answer)).toBeCloseTo(first, 10);
        total += answerLikelihood(question, fault, answer);
      }
      // And it is a real probability row, like every modelled one.
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it('an unmodelled fault is not promoted by the reassuring answer', () => {
    const belief = classifySymptoms(symptoms({ primaryComplaint: 'UNKNOWN' }));
    const question = findQuestion('FUEL_GAUGE')!;

    // "The gauge shows fuel" is evidence against running out of fuel, and
    // nothing at all about brakes — so brake failure must not gain more than
    // the arithmetic of renormalising forces.
    const reassuring = posteriorForAnswer(belief, question, 'HAS_FUEL');
    expect(reassuring.OUT_OF_FUEL).toBeLessThan(belief.OUT_OF_FUEL);

    const ratioBefore = belief.BRAKE_FAILURE / belief.IMMOBILISED_UNKNOWN;
    const ratioAfter = reassuring.BRAKE_FAILURE / reassuring.IMMOBILISED_UNKNOWN;
    expect(ratioAfter).toBeCloseTo(ratioBefore, 10);
  });
});

describe('safety triage', () => {
  function context(overrides: Partial<SafetyContext> = {}): SafetyContext {
    return safetyContextSchema.parse(overrides);
  }

  it('a car in a car park with nothing wrong around it is NORMAL', () => {
    expect(triageSafety(context())).toEqual({ level: 'NORMAL', reasonCodes: [] });
  });

  it('blocking a live lane, fire and fuel are each HIGH_RISK on their own', () => {
    expect(triageSafety(context({ blockingLiveLane: true })).level).toBe('HIGH_RISK');
    expect(triageSafety(context({ smokeOrBurningSmell: true })).level).toBe('HIGH_RISK');
    expect(triageSafety(context({ fuelSmell: true })).level).toBe('HIGH_RISK');
  });

  it('a highway shoulder in slow traffic is ELEVATED, not HIGH_RISK', () => {
    const triage = triageSafety(context({ onHighway: true, trafficSpeedKph: 30 }));

    expect(triage.level).toBe('ELEVATED');
    expect(triage.reasonCodes).toContain('ON_HIGHWAY');
  });

  it('the same shoulder with traffic at 100 is HIGH_RISK', () => {
    const triage = triageSafety(context({ onHighway: true, trafficSpeedKph: 100 }));

    expect(triage.level).toBe('HIGH_RISK');
    expect(triage.reasonCodes).toContain('STOPPED_IN_FAST_TRAFFIC');
  });

  it('alone on a highway at night is HIGH_RISK even with nothing else wrong', () => {
    const triage = triageSafety(
      context({ onHighway: true, trafficSpeedKph: 40, night: true, driverAlone: true }),
    );

    expect(triage.level).toBe('HIGH_RISK');
    expect(triage.reasonCodes).toContain('ALONE_AT_NIGHT_ON_HIGHWAY');
  });

  it('an unknown traffic speed does not manufacture a HIGH_RISK', () => {
    const triage = triageSafety(context({ onHighway: true, trafficSpeedKph: null }));

    expect(triage.level).toBe('ELEVATED');
    expect(triage.reasonCodes).not.toContain('STOPPED_IN_FAST_TRAFFIC');
  });

  it('vulnerable passengers and overheating each raise it to ELEVATED', () => {
    expect(triageSafety(context({ vulnerablePassengers: true })).level).toBe('ELEVATED');
    expect(triageSafety(context({ overheating: true })).level).toBe('ELEVATED');
  });

  // The level is the HIGHEST rule that fired, not the first one in the list.
  // ON_HIGHWAY is only ELEVATED and it fires first here, so anything that took
  // the level from the leading reason instead of the worst one would report
  // ELEVATED for a car blocking a live lane.
  it('reports every reason that fired, and takes the worst level', () => {
    const triage = triageSafety(
      context({
        onHighway: true,
        trafficSpeedKph: 30,
        blockingLiveLane: true,
        vulnerablePassengers: true,
      }),
    );

    expect(triage.reasonCodes[0]).toBe('ON_HIGHWAY');
    expect(triage.reasonCodes).toEqual([
      'ON_HIGHWAY',
      'BLOCKING_LIVE_LANE',
      'VULNERABLE_PASSENGERS',
    ]);
    expect(triage.level).toBe('HIGH_RISK');
  });

  it('night is 21:00 to 06:00 in Bengaluru local time, not UTC', () => {
    // 09:00Z is 14:30 IST — the middle of the afternoon.
    expect(isNightAt(new Date('2026-06-01T09:00:00Z'))).toBe(false);
    // 18:00Z is 23:30 IST.
    expect(isNightAt(new Date('2026-06-01T18:00:00Z'))).toBe(true);
    // 00:00Z is 05:30 IST — still dark.
    expect(isNightAt(new Date('2026-06-01T00:00:00Z'))).toBe(true);
    // 00:30Z is exactly 06:00 IST — the boundary, and no longer night.
    expect(isNightAt(new Date('2026-06-01T00:30:00Z'))).toBe(false);
  });
});

describe('location refinement', () => {
  it('collapses a compass bearing onto one of four carriageways', () => {
    expect(carriagewayFromHeading(0)).toBe('NORTHBOUND');
    expect(carriagewayFromHeading(44)).toBe('NORTHBOUND');
    expect(carriagewayFromHeading(46)).toBe('EASTBOUND');
    expect(carriagewayFromHeading(90)).toBe('EASTBOUND');
    expect(carriagewayFromHeading(180)).toBe('SOUTHBOUND');
    expect(carriagewayFromHeading(270)).toBe('WESTBOUND');
    expect(carriagewayFromHeading(350)).toBe('NORTHBOUND');
  });

  it('says nothing rather than guessing when the heading is unknown', () => {
    expect(carriagewayFromHeading(null)).toBeNull();
  });

  // The reason carriageway is first-class: these two vehicles are metres apart
  // in a straight line and 20km apart by road.
  it('opposite sides of a divided highway are different carriageways', () => {
    expect(carriagewayFromHeading(10)).not.toBe(carriagewayFromHeading(190));
  });

  it('derives the carriageway into the columns a job row stores', () => {
    const columns = locationColumns(
      locationSchema.parse({
        lat: 12.9352,
        lng: 77.6245,
        headingDegrees: 95,
        roadPosition: 'SHOULDER',
        kmMarker: 'KM 42',
        onHighway: true,
      }),
    );

    expect(columns.carriagewayDirection).toBe('EASTBOUND');
    expect(columns.roadPosition).toBe('SHOULDER');
    expect(columns.kmMarker).toBe('KM 42');
    expect(columns.onHighway).toBe(true);
    expect(columns.landmark).toBeNull();
    expect(columns.parkingLevel).toBeNull();
  });

  it('rejects coordinates and headings that cannot exist', () => {
    expect(() => locationSchema.parse({ lat: 91, lng: 77 })).toThrow();
    expect(() => locationSchema.parse({ lat: 12.9, lng: 181 })).toThrow();
    expect(() => locationSchema.parse({ lat: 12.9, lng: 77.6, headingDegrees: 360 })).toThrow();
  });

  it('measures real distances between the seeded zones', () => {
    // Koramangala to Whitefield is about 14km as the crow flies.
    const km = distanceKm(12.9352, 77.6245, 12.9698, 77.7499);

    expect(km).toBeGreaterThan(10);
    expect(km).toBeLessThan(18);
    expect(distanceKm(12.9352, 77.6245, 12.9352, 77.6245)).toBeCloseTo(0, 6);
  });

  it('assigns a breakdown to the nearest zone centroid', () => {
    const zones = [
      { id: 'zone-kor', centroidLat: 12.9352, centroidLng: 77.6245 },
      { id: 'zone-whf', centroidLat: 12.9698, centroidLng: 77.7499 },
      { id: 'zone-heb', centroidLat: 13.0358, centroidLng: 77.597 },
    ];

    expect(nearestZone(zones, 12.94, 77.63)?.id).toBe('zone-kor');
    expect(nearestZone(zones, 12.97, 77.75)?.id).toBe('zone-whf');
    expect(nearestZone([], 12.9, 77.6)).toBeNull();
  });
});
