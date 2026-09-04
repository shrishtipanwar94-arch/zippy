// THE WHILE-YOU-WAIT CARD.
//
// THIS FUNCTION TAKES A SAFETY LEVEL AND NOTHING ELSE. That is not an
// oversight and it must not be "improved" — it is the whole design.
//
// The phase brief is explicit: the guidance must be GENERIC and CONSERVATIVE,
// never diagnostic, never predictive about the vehicle. "This is not an
// emergency-advice engine." The cheapest way to guarantee that is to make it
// structurally impossible to be situation-specific: with no fault, no
// hypothesis and no vehicle in scope, no future change can quietly start
// tailoring the advice to what we THINK is wrong. A single parameter is the
// enforcement mechanism.
//
// Why it matters. Zippy's belief about the fault is a probability
// distribution that is frequently wrong — that is the premise of the whole
// re-dispatch machinery in Phase 13. Advice derived from a guess ("your
// alternator is failing, you can drive a short distance") would be given with
// far more confidence than the guess deserves, to somebody who cannot judge
// it, in a place where being wrong is dangerous. Safety level, by contrast, is
// derived from where the vehicle is standing and who is in it — facts, not
// inference — so it is the only input that is safe to act on.
//
// The advice below is the ordinary, widely-published roadside guidance. It
// deliberately says nothing that requires knowing anything about this car.

import type { SafetyLevel } from '@prisma/client';

export type SafetyGuidance = {
  headline: string;
  points: string[];
  // Shown under every card, at every level. A reminder that the person at the
  // roadside can see things this system cannot.
  note: string;
};

const NOTE =
  'You know your situation best. Stay safe.';

const GUIDANCE: Record<SafetyLevel, SafetyGuidance> = {
  NORMAL: {
    headline: 'While you wait',
    points: [
      'Switch on your hazard lights.',
      'Stay with your vehicle if you feel safe doing so.',
      'Keep your phone with you — we will keep this page updated.',
    ],
    note: NOTE,
  },
  ELEVATED: {
    headline: 'While you wait — take care',
    points: [
      'Switch on your hazard lights.',
      'If it is safe to do so, move away from moving traffic.',
      'Wear a reflective vest if you have one.',
      'Do not attempt a repair yourself.',
    ],
    note: NOTE,
  },
  HIGH_RISK: {
    headline: 'Please move somewhere safe',
    points: [
      'Switch on your hazard lights.',
      'If it is safe to do so, get everyone out of the vehicle and behind a barrier, away from moving traffic.',
      'Stand well clear of the vehicle and of traffic while you wait.',
      'Do not attempt a repair yourself.',
      'If anyone is hurt or in immediate danger, call 112 now.',
    ],
    note: NOTE,
  },
};

export function guidanceFor(level: SafetyLevel): SafetyGuidance {
  return GUIDANCE[level];
}
