// MONEY IS INTEGER PAISE. EVERYWHERE. ALWAYS.
//
// Not rupees, not a Float, not a decimal string. One rupee is 100 paise and
// every amount in this codebase is a whole number of them, because the
// alternative is the oldest bug in commercial software: 0.1 + 0.2 is not 0.3
// in IEEE 754, and a ledger that must sum to exactly zero (Phase 15c's
// central invariant) cannot be built on a type that cannot represent a tenth
// reliably. The schema has said `Int` since Phase 1; this file is where the
// rule gets a home and a name.
//
// THE ONLY PLACE ROUNDING HAPPENS is `roundToPaise`. Money enters this system
// as integers and leaves as integers; the only operations that can produce a
// fraction are the two multiplications pricing does — hours times an hourly
// rate, and kilometres times a per-kilometre tariff. Both go through here, so
// "where do we round?" has one answer instead of being a property of whichever
// expression happened to be written first.
//
// HALF-UP, AND IT IS A CHOICE. `Math.round` rounds .5 away from zero for
// positive numbers, so 1.5 paise becomes 2. Banker's rounding (half-to-even)
// is the usual accounting answer because it does not bias a large population
// of roundings upward. It is not used here for one reason: every amount this
// project rounds is a single line on a single invoice a human will read, and
// "we rounded your 1.5 paise down because the digit before it was even" is not
// an explanation anybody wants. The bias is at most half a paise per line.

export type Paise = number;

export function roundToPaise(value: number): Paise {
  return Math.round(value);
}

export function sumPaise(amounts: Paise[]): Paise {
  let total = 0;
  for (const amount of amounts) total += amount;
  return total;
}

// THE ONLY PLACE PAISE BECOME WORDS. Indian digit grouping — ₹2,340 and
// ₹1,44,000, not ₹144,000 — because `en-IN` groups in lakhs and crores and
// this product's customers read invoices that way.
export function formatRupees(paise: Paise): string {
  // THE SIGN GOES BEFORE THE SYMBOL. Formatting the number first and prefixing
  // ₹ produces "₹-948", which is not how anybody writes a deduction — an
  // invoice line reads "-₹948". Found when the covered half of an estimate
  // first had to be shown as a negative.
  const sign = paise < 0 ? '-' : '';
  const rupees = Math.abs(paise) / 100;
  return `${sign}₹${rupees.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}
