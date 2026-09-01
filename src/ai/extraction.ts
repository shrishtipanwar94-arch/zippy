// WHAT THE MODEL IS ASKED TO RETURN, and how that becomes the two structured
// objects intake already takes.
//
// STRUCTURED OUTPUT / SCHEMA-CONSTRAINED DECODING
// The Messages API can be handed a JSON schema and will only emit JSON that
// fits it (`output_config.format`). We still validate the reply with Zod here,
// because "the provider promised" is not the same as "we checked", and the
// evaluation harness reports a schemaValidRate that would be a fiction if
// nothing ever actually validated. Belt and braces, and the braces are cheap.
//
// THE MODEL FILLS IN A FORM. It does not diagnose, it does not rank faults and
// it does not pick a technician (invariant 5). Everything below is a field the
// driver could have tapped themselves — the model's whole job is saving them
// the taps, and the driver confirms every value before dispatch sees it.
//
// 'NOT_STATED' RATHER THAN null. The symptom payload already draws a line
// between "nobody asked" (null) and "asked, driver could not tell" (UNSURE),
// and that distinction is load-bearing in the rule table. Giving the model a
// null to emit would blur the two, so it emits an explicit third value and the
// conversion below maps it back to null.

import { z } from 'zod';
import {
  PRIMARY_COMPLAINTS,
  UNUSUAL_SOUNDS,
  WARNING_LIGHTS,
  symptomPayloadSchema,
} from '../domain/symptoms.js';
import type { SymptomPayload } from '../domain/symptoms.js';
import { safetyReportSchema } from '../domain/safety.js';
import type { SafetyReport } from '../domain/safety.js';

// THE URGENCY SIGNALS ARE THE SAFETY FORM, not a free-text list of worries.
// Each code below is exactly one boolean on `safetyReportSchema`, so a signal
// the model hears in the driver's sentence lands on the checkbox the driver is
// then shown, ticked, for them to confirm or clear. A signal that mapped to
// nothing would be decoration.
export const URGENCY_SIGNALS = [
  'BLOCKING_LIVE_LANE',
  'SMOKE_OR_BURNING_SMELL',
  'FUEL_SMELL',
  'OVERHEATING',
  'DRIVER_ALONE',
  'VULNERABLE_PASSENGERS',
] as const;

export type UrgencySignal = (typeof URGENCY_SIGNALS)[number];

const SAFETY_FIELD_BY_SIGNAL: Record<UrgencySignal, keyof SafetyReport> = {
  BLOCKING_LIVE_LANE: 'blockingLiveLane',
  SMOKE_OR_BURNING_SMELL: 'smokeOrBurningSmell',
  FUEL_SMELL: 'fuelSmell',
  OVERHEATING: 'overheating',
  DRIVER_ALONE: 'driverAlone',
  VULNERABLE_PASSENGERS: 'vulnerablePassengers',
};

// Recorded, shown to the driver, and consumed by nothing. Fuel type is the
// obvious future feasibility input — an EV with a high-voltage fault needs a
// certified technician — but wiring a model's guess into a hard filter is
// exactly the move invariant 5 forbids, so it stays a display field until a
// human confirms it somewhere. Named in this phase's weaknesses.
const vehicleContextSchema = z.object({
  make: z.string().max(40).nullable(),
  model: z.string().max(40).nullable(),
  fuel: z.enum(['PETROL', 'DIESEL', 'EV', 'CNG', 'UNKNOWN']),
});

export const symptomExtractionSchema = z.object({
  primaryComplaint: z.enum(PRIMARY_COMPLAINTS),
  engineCranks: z.enum(['YES', 'NO', 'UNSURE', 'NOT_STATED']),
  warningLights: z.array(z.enum(WARNING_LIGHTS)).max(6),
  unusualSound: z.enum([...UNUSUAL_SOUNDS, 'NOT_STATED']),
  vehicleMoves: z.enum(['YES', 'NO', 'NOT_STATED']),
  urgencySignals: z.array(z.enum(URGENCY_SIGNALS)).max(URGENCY_SIGNALS.length),
  vehicleContext: vehicleContextSchema,
  // The driver's own words that produced the fields above. Shown on the
  // confirmation screen for the same reason a feasibility rejection carries a
  // reason code: a person asked to confirm a machine's reading needs to see
  // what it read, not be asked to trust it.
  evidence: z.string().max(400),
});

export type SymptomExtraction = z.infer<typeof symptomExtractionSchema>;

export type VehicleContext = z.infer<typeof vehicleContextSchema>;

export function toSymptomPayload(extraction: SymptomExtraction): SymptomPayload {
  return symptomPayloadSchema.parse({
    primaryComplaint: extraction.primaryComplaint,
    engineCranks: extraction.engineCranks === 'NOT_STATED' ? null : extraction.engineCranks,
    // De-duplicated because the rule table applies one likelihood update per
    // light, and a model that says BATTERY twice would double-count evidence
    // the driver only gave once.
    warningLights: [...new Set(extraction.warningLights)],
    unusualSound: extraction.unusualSound === 'NOT_STATED' ? null : extraction.unusualSound,
    vehicleMoves: vehicleMovesToBoolean(extraction.vehicleMoves),
  });
}

function vehicleMovesToBoolean(value: SymptomExtraction['vehicleMoves']): boolean | null {
  if (value === 'YES') return true;
  if (value === 'NO') return false;
  return null;
}

// The safety form, pre-ticked. Every field the driver did not mention stays
// false — the schema's own default — because an unmentioned hazard is not a
// denied one, and the driver is about to be shown these boxes anyway.
export function toSafetyReport(extraction: SymptomExtraction): SafetyReport {
  const report: Record<string, boolean> = {};
  for (const signal of extraction.urgencySignals) {
    report[SAFETY_FIELD_BY_SIGNAL[signal]] = true;
  }
  return safetyReportSchema.parse(report);
}

// THE SAME MAP, READ BACKWARDS — so the picker path can label its hypothesis
// with the same urgency signals the described path does. A job that took the
// degraded route must produce an identically shaped view (src/domain/
// hypothesisView.ts), and that includes this list.
export function signalsFromSafetyReport(report: SafetyReport): UrgencySignal[] {
  const signals: UrgencySignal[] = [];
  for (const signal of URGENCY_SIGNALS) {
    if (report[SAFETY_FIELD_BY_SIGNAL[signal]] === true) signals.push(signal);
  }
  return signals;
}
