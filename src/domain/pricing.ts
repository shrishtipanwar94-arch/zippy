// WHAT A THING COSTS — the arithmetic, and nothing else.
//
// PURE. This file takes a RATE CARD (already resolved from the database by
// src/pricing/rateCard.ts) and a quantity, and returns an amount in paise. No
// Prisma, no clock, no decision about WHICH rate card — that is the whole
// point of the split. Which prices apply to a job is a question about time and
// contracts and is answered once, at job creation; what those prices come to
// is arithmetic and is answered here, and the two are easy to confuse and
// expensive to entangle.
//
// A LINE, NOT A TOTAL. Every function returns one priced line with the inputs
// still visible on it — quantity, unit price, and the amount they produce.
// That is what lets an estimate be ITEMISED (Phase 15c section 2) and what
// lets a driver see "Labour 1.0h @ ₹800" instead of a number they have to
// take on trust. A function that returned only the amount would make the
// itemisation impossible to reconstruct later.

import { roundToPaise, sumPaise } from './money.js';
import type { Paise } from './money.js';

// One row of an estimate. `kind` matches the `estimate_lines.kind` column the
// money domain will write; `refId` points at whatever the line is about — a
// part id, a labour rate code — so a line can be traced back to the catalogue
// entry that produced it.
export type PricedLine = {
  kind: 'PART' | 'LABOUR' | 'TOW' | 'CALLOUT';
  description: string;
  quantity: number;
  unitPricePaise: Paise;
  amountPaise: Paise;
  refId: string | null;
};

// What the rate card must supply for each kind of line. Deliberately the
// smallest shape the arithmetic needs, rather than the database rows — a
// pricing function that took a Prisma model could not be called with a
// hypothetical rate, and half the value of pure pricing is being able to ask
// "what would this have cost on last year's list?".
export type PartRate = { partId: string; description: string; unitPricePaise: Paise };
export type LabourRate = { code: string; ratePerHourPaise: Paise };
export type TowRate = { towType: string; perKmPaise: Paise; minChargePaise: Paise };
export type CalloutRate = { serviceType: string; feePaise: Paise };

export function priceParts(rate: PartRate, quantity: number): PricedLine {
  return {
    kind: 'PART',
    description: rate.description,
    quantity,
    unitPricePaise: rate.unitPricePaise,
    amountPaise: roundToPaise(rate.unitPricePaise * quantity),
    refId: rate.partId,
  };
}

export function priceLabour(rate: LabourRate, hours: number): PricedLine {
  return {
    kind: 'LABOUR',
    // The hours are on the line, so "1h @ ₹600" is reconstructable from the
    // row rather than only from the sentence.
    description: `Labour, ${hours}h`,
    quantity: hours,
    unitPricePaise: rate.ratePerHourPaise,
    amountPaise: roundToPaise(rate.ratePerHourPaise * hours),
    refId: rate.code,
  };
}

// THE MINIMUM CHARGE IS THE INTERESTING RULE HERE. A two-hundred-metre tow
// still costs a truck, a driver and an hour of their day, so a tariff has a
// floor as well as a rate. Applying it here rather than at the call site means
// there is one definition of what a tow costs, and a short tow cannot be
// quoted at a price nobody would accept the job for.
export function priceTow(rate: TowRate, kilometres: number): PricedLine {
  const metered = roundToPaise(rate.perKmPaise * kilometres);
  const amountPaise = Math.max(metered, rate.minChargePaise);

  return {
    kind: 'TOW',
    description:
      amountPaise > metered
        ? `Tow, ${kilometres}km (minimum charge)`
        : `Tow, ${kilometres}km`,
    quantity: kilometres,
    unitPricePaise: rate.perKmPaise,
    amountPaise,
    refId: rate.towType,
  };
}

export function priceCallout(rate: CalloutRate): PricedLine {
  return {
    kind: 'CALLOUT',
    description: 'Callout',
    // A flat fee is one of itself at its own price. Modelling it as quantity 1
    // rather than as a special case keeps every line the same shape, which is
    // what lets the total be a plain sum.
    quantity: 1,
    unitPricePaise: rate.feePaise,
    amountPaise: rate.feePaise,
    refId: rate.serviceType,
  };
}

export function totalOf(lines: PricedLine[]): Paise {
  return sumPaise(lines.map((line) => line.amountPaise));
}
