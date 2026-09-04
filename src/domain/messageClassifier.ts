// WHAT A MESSAGE MIGHT BE TELLING US — a rule table, and nothing more.
//
// Roadside incidents contain information no intake form can anticipate. "I'm
// on the service road, not the highway." "There's a divider between me and the
// technician." Those sentences change a dispatch decision, and today they sit
// in a chat log where nothing acts on them.
//
// THIS FUNCTION FLAGS. IT NEVER DECIDES — invariant 5, and the single most
// important line in this file. What comes out is a PROPOSAL that a human is
// asked to confirm (src/commit/eventPromotions.ts). A message that silently
// rewrote a dispatch location is how a technician is sent to the wrong place
// with no audit trail, so the machinery is deliberately built so that no code
// path exists from "a message arrived" to "the job changed" without a person
// in the middle.
//
// RULE-BASED, NOT AN LLM, and that is Phase 16's business rather than a
// permanent choice. The shape is what matters: whatever produces these
// classifications, a human still confirms them, so swapping the producer
// changes this file and nothing downstream.
//
// FLAG AGGRESSIVELY. The brief is explicit and the asymmetry is real: a false
// positive costs somebody one tap to dismiss, and a false negative leaves a
// driver standing in a live lane ranked as routine. So the phrases below are
// broad, one message may raise several promotions, and none of that is a bug.
//
// PURE. No database, no clock — the same sentence always classifies the same
// way, and the rules can be argued with in a test.

import type { PromotionKind, RoadPosition } from '@prisma/client';

export type Classification = {
  kind: PromotionKind;
  // The phrases that fired. Carried through to the confirmation screen so the
  // person deciding can see WHY this was flagged rather than being asked to
  // trust it — the same reason feasibility rejections carry reason codes.
  matched: string[];
  // What would be written IF a human confirms. Never applied here.
  proposedPayload: PromotionPayload;
};

export type PromotionPayload = {
  // SAFETY_CHANGE. Only ever an escalation — see promotionPolicy.ts.
  safetyLevel?: 'HIGH_RISK';
  // LOCATION_CORRECTION. Either the driver named a position in words, or the
  // structured "send my exact location" action supplied coordinates.
  roadPosition?: RoadPosition;
  lat?: number;
  lng?: number;
  // ACCESS_RESTRICTION and DIAGNOSIS_DETAIL carry the driver's own words,
  // because there is nothing structured to extract and the sentence itself is
  // the operational information.
  note?: string;
};

type Rule = {
  kind: PromotionKind;
  phrases: string[];
  // Extra facts a match implies. Only LOCATION_CORRECTION has any: a sentence
  // that names where the vehicle is standing is proposing a road position, and
  // road position is what `on_highway` and the safety triage are derived from
  // (src/domain/location.ts), so it is a real structured change rather than a
  // note.
  implies?: PromotionPayload;
};

// Grouped by kind so the table reads as "these are the ways a driver says X".
// Phrases are matched case-insensitively against the whole message, as
// substrings — not word boundaries — because "blocking" should fire on
// "we're blocking" and on "roadblocking" is not a word anybody writes.
const RULES: Rule[] = [
  // ---- SAFETY. The escalation the brief cares most about. ----
  { kind: 'SAFETY_CHANGE', phrases: ['blocking', 'in the lane', 'live lane', 'left lane', 'right lane', 'middle lane'] },
  { kind: 'SAFETY_CHANGE', phrases: ['smoke', 'smoking', 'burning', 'fire', 'flames'] },
  { kind: 'SAFETY_CHANGE', phrases: ['smell of fuel', 'fuel smell', 'petrol smell', 'diesel leak', 'leaking fuel'] },
  { kind: 'SAFETY_CHANGE', phrases: ['hit', 'accident', 'crash', 'collision'] },
  { kind: 'SAFETY_CHANGE', phrases: ['not safe', 'unsafe', 'dangerous', 'scared', 'frightened'] },
  { kind: 'SAFETY_CHANGE', phrases: ['traffic is fast', 'cars are speeding', 'trucks are passing'] },

  // ---- LOCATION. The brief's own example sentence lives in the first row. ----
  {
    kind: 'LOCATION_CORRECTION',
    phrases: ['service road', 'service lane'],
    implies: { roadPosition: 'SERVICE_ROAD' },
  },
  {
    kind: 'LOCATION_CORRECTION',
    phrases: ['hard shoulder', 'on the shoulder', 'side of the highway', 'side of the expressway'],
    implies: { roadPosition: 'SHOULDER' },
  },
  {
    kind: 'LOCATION_CORRECTION',
    phrases: ['car park', 'parking lot', 'basement', 'parking level', 'driveway'],
    implies: { roadPosition: 'PARKING' },
  },
  {
    kind: 'LOCATION_CORRECTION',
    phrases: ['in the lane', 'live lane', 'left lane', 'right lane', 'middle lane'],
    implies: { roadPosition: 'LANE' },
  },
  // Corrections that name no position — they still need a human to look.
  { kind: 'LOCATION_CORRECTION', phrases: ['not the highway', 'not on the highway', 'wrong side', 'other side', 'opposite side', 'moved the car', 'i have moved', 'actually near', 'actually at'] },

  // ---- ACCESS. What stops a van reaching a vehicle it can see. ----
  { kind: 'ACCESS_RESTRICTION', phrases: ['divider', 'barrier', 'median', 'no entry', 'one way', 'one-way'] },
  { kind: 'ACCESS_RESTRICTION', phrases: ['locked gate', 'gate is locked', 'security gate', 'guard will not', 'guard wont'] },
  { kind: 'ACCESS_RESTRICTION', phrases: ['height limit', 'low ceiling', 'clearance', 'too narrow', 'cannot get in', "can't get in"] },
  { kind: 'ACCESS_RESTRICTION', phrases: ['road is closed', 'road closed', 'diversion', 'construction'] },

  // ---- DIAGNOSIS. Detail for the technician, never a change to the fault
  // distribution — only an on-site diagnosis moves that (Phase 13).
  { kind: 'DIAGNOSIS_DETAIL', phrases: ['warning light', 'check engine', 'battery light', 'temperature light'] },
  { kind: 'DIAGNOSIS_DETAIL', phrases: ['grinding', 'clicking', 'whining', 'rattling', 'knocking'] },
  { kind: 'DIAGNOSIS_DETAIL', phrases: ['leaking', 'puddle', 'steam', 'overheat'] },
  { kind: 'DIAGNOSIS_DETAIL', phrases: ['will not turn over', 'wont turn over', "won't turn over", 'no power', 'dead'] },
];

export function classifyMessage(body: string): Classification[] {
  const haystack = body.toLowerCase();

  // Accumulated per kind, because several rows of the same kind can fire on one
  // sentence and they are ONE proposal about that sentence, not three.
  const byKind = new Map<PromotionKind, Classification>();

  for (const rule of RULES) {
    const hits = rule.phrases.filter((phrase) => haystack.includes(phrase));
    if (hits.length === 0) continue;

    const existing = byKind.get(rule.kind);
    if (existing) {
      existing.matched.push(...hits);
      Object.assign(existing.proposedPayload, rule.implies ?? {});
      continue;
    }

    byKind.set(rule.kind, {
      kind: rule.kind,
      matched: [...hits],
      proposedPayload: { ...defaultPayloadFor(rule.kind, body), ...(rule.implies ?? {}) },
    });
  }

  return [...byKind.values()];
}

function defaultPayloadFor(kind: PromotionKind, body: string): PromotionPayload {
  // A safety flag always proposes the same thing, and only in one direction.
  if (kind === 'SAFETY_CHANGE') return { safetyLevel: 'HIGH_RISK' };
  // Everything else carries the sentence, because the sentence IS the
  // information and paraphrasing it would lose what the driver actually said.
  return { note: body.slice(0, 500) };
}

// The structured "send my exact location" tap. Not a classification of text —
// the driver pressed a button — but it produces the same kind of proposal and
// goes through the same confirmation, because moving a job's dispatch location
// is exactly the change that must never happen without a human.
// THE ACCURACY TRAVELS INTO THE PROPOSAL, and that is the point of carrying it
// at all. An operator confirming a LOCATION_CORRECTION is deciding whether to
// move a job to a new position; "the driver says they are here, to within eight
// metres" and "…to within nine hundred metres" are different decisions, and
// before this they arrived as the same one.
export function locationShareClassification(
  coordinates: { lat: number; lng: number },
  accuracyMetres?: number,
): Classification {
  return {
    kind: 'LOCATION_CORRECTION',
    matched: [
      accuracyMetres === undefined
        ? 'shared exact location'
        : `shared location, accurate to about ${Math.round(accuracyMetres)}m`,
    ],
    proposedPayload: {
      lat: coordinates.lat,
      lng: coordinates.lng,
      ...(accuracyMetres === undefined ? {} : { accuracyMetres: Math.round(accuracyMetres) }),
    },
  };
}
