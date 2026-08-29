// The structured symptom payload a driver submits at intake, and its Zod
// schema. This is the INPUT boundary of the diagnosis pipeline.
//
// Phase 16 replaces how this object gets filled in — free text through an LLM
// extractor — but never its shape. Everything downstream reads this type, so
// swapping the producer changes one file and no maths. That is the whole point
// of pinning the structure now (invariant 5: the LLM extracts, it never
// decides).

import { z } from 'zod';

// What the driver says is wrong, in their words, from a fixed list. The single
// most informative field — it is what separates "flat tyre" (ask nothing) from
// "won't start" (ask three).
export const PRIMARY_COMPLAINTS = [
  'WONT_START',
  'FLAT_TYRE',
  'LOCKED_OUT',
  'WARNING_LIGHT',
  'NOISE_OR_SMELL',
  'STUCK_OR_DAMAGED',
  'UNKNOWN',
] as const;

export const WARNING_LIGHTS = [
  'BATTERY',
  'ENGINE',
  'TEMPERATURE',
  'OIL',
  'BRAKE',
  'EV_SYSTEM',
] as const;

export const UNUSUAL_SOUNDS = ['NONE', 'CLICKING', 'GRINDING', 'WHINING', 'BANG', 'UNSURE'] as const;

export const symptomPayloadSchema = z.object({
  primaryComplaint: z.enum(PRIMARY_COMPLAINTS),
  // Null means "not asked / not known", which is different from UNSURE ("asked,
  // driver could not tell"). Only a stated value updates the distribution.
  engineCranks: z.enum(['YES', 'NO', 'UNSURE']).nullable().default(null),
  warningLights: z.array(z.enum(WARNING_LIGHTS)).default([]),
  unusualSound: z.enum(UNUSUAL_SOUNDS).nullable().default(null),
  vehicleMoves: z.boolean().nullable().default(null),
});

export type SymptomPayload = z.infer<typeof symptomPayloadSchema>;
