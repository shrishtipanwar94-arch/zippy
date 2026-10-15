// WHAT AN ESTIMATE WAS PRICED FROM, as one comparable string.
//
// Estimate creation is idempotent per priced inputs: a technician pressing
// "Send the driver a cost" twice with nothing changed gets the same estimate
// back, and only a change to something that moves the price issues a new one.
// That needs "nothing changed" to be a single equality check, so every input
// that feeds the price is written into one canonical string here.
//
// Parts and labour are derived from the diagnosis today, and are listed anyway:
// if that mapping is edited in a deploy, the same fault now prices differently
// and the driver should be quoted again.

import { labourCodeForFault, partSkusForFault } from './faults.js';
import type { FaultCode } from './faults.js';
import { resolveMinutes } from '../engine/durations.js';

export type PricedInputs = {
  fault: FaultCode;
  priceListId: string;
  onHighway: boolean;
  towKilometres?: number;
};

export function describePricedInputs(input: PricedInputs): string {
  // Sorted so the same set of parts always produces the same string, whatever
  // order the fault table happens to list them in.
  const partSkus = [...partSkusForFault(input.fault)].sort();
  const labourHours = Number((resolveMinutes(input.fault) / 60).toFixed(2));

  // A fixed key order is what makes JSON.stringify usable as a comparison:
  // the object is built literally here, never spread from the caller's.
  const canonical = {
    fault: input.fault,
    priceListId: input.priceListId,
    partSkus,
    labourCode: labourCodeForFault(input.fault),
    labourHours,
    towKilometres: input.towKilometres ?? null,
    onHighway: input.onHighway,
  };
  return JSON.stringify(canonical);
}
