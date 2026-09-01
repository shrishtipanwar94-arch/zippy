// THE SECOND, SMALLER JOB — does this chat message carry operational
// information? Classification only. A human commits.
//
// THIS ADDS TO THE RULE TABLE, IT DOES NOT REPLACE IT. src/domain/
// messageClassifier.ts still runs on every message, still first, and still
// decides on its own when the model is unavailable. What the model adds is the
// thing a phrase list structurally cannot do: the same meaning said a different
// way, or said in Hindi. "Main service road pe hoon" is a location correction
// that no English substring in that table will ever match.
//
// THE SHAPE IS UNCHANGED, and that is what makes this safe. Whatever produces
// a Classification, it lands in the same FLAGGED EventPromotion that a person
// must confirm before anything happens to the job (src/commit/
// eventPromotions.ts). There is still no code path from "a message arrived" to
// "the job changed" without a human in the middle — invariant 5, and the
// reason this phase can add a model to chat at all.
//
// FAILURE IS SILENT AND SAFE. No key, a timeout, a bad body — the function
// returns nothing extra and the rule table's own findings stand. A message
// send must never fail because a model did.

import { z } from 'zod';
import type { PromotionKind, RoadPosition } from '@prisma/client';
import { callModel, isLlmConfigured, LlmError } from './client.js';
import type { SchemaCall } from './client.js';
import { MESSAGE_SYSTEM_PROMPT, messageUserMessage } from './prompt.js';
import { classifyMessage } from '../domain/messageClassifier.js';
import type { Classification } from '../domain/messageClassifier.js';

const messageClassificationSchema = z.object({
  findings: z
    .array(
      z.object({
        kind: z.enum(['LOCATION_CORRECTION', 'ACCESS_RESTRICTION', 'SAFETY_CHANGE', 'DIAGNOSIS_DETAIL']),
        // The words that made it flag, in the sender's own language. Shown on
        // the confirmation card next to the rule table's matches, so the
        // person deciding sees the evidence rather than a verdict.
        evidence: z.array(z.string().max(200)).max(4),
        // Only a location correction can name a position, and only when the
        // message actually says one. NOT_STATED is the normal answer.
        roadPosition: z.enum(['SHOULDER', 'LANE', 'SERVICE_ROAD', 'PARKING', 'NOT_STATED']),
      }),
    )
    .max(4),
});

export type MessageClassificationResult = {
  classifications: Classification[];
  // Whether the model contributed. The caller uses it to move the health row —
  // an operator seeing promotions raised by a rule table alone should know that
  // is what they are looking at.
  modelUsed: boolean;
};

export async function classifyMessageWithAi(
  body: string,
  call: SchemaCall = callModel,
  configured: () => boolean = isLlmConfigured,
): Promise<MessageClassificationResult> {
  const fromRules = classifyMessage(body);
  if (!configured()) return { classifications: fromRules, modelUsed: false };

  try {
    const result = await call(
      messageClassificationSchema,
      MESSAGE_SYSTEM_PROMPT,
      messageUserMessage(body),
    );
    return { classifications: merge(fromRules, result.value.findings, body), modelUsed: true };
  } catch (error) {
    // Deliberately not rethrown. The rule table's answer is a complete answer.
    if (!(error instanceof LlmError)) throw error;
    return { classifications: fromRules, modelUsed: false };
  }
}

type Finding = z.infer<typeof messageClassificationSchema>['findings'][number];

// One proposal per kind, whichever side found it. Where both did, the rule
// table's structured payload wins and the model's evidence is appended: the
// table's road position came from a phrase somebody wrote down and can argue
// with, and between two answers about where a vehicle is standing, the one a
// human can audit is the one to keep.
function merge(fromRules: Classification[], findings: Finding[], body: string): Classification[] {
  const byKind = new Map<PromotionKind, Classification>();
  for (const classification of fromRules) {
    byKind.set(classification.kind, classification);
  }

  for (const finding of findings) {
    const existing = byKind.get(finding.kind);
    if (existing) {
      existing.matched.push(...finding.evidence);
      continue;
    }
    byKind.set(finding.kind, {
      kind: finding.kind,
      matched: [...finding.evidence],
      proposedPayload: payloadFor(finding, body),
    });
  }

  return [...byKind.values()];
}

function payloadFor(finding: Finding, body: string): Classification['proposedPayload'] {
  if (finding.kind === 'SAFETY_CHANGE') return { safetyLevel: 'HIGH_RISK' };
  if (finding.kind === 'LOCATION_CORRECTION' && finding.roadPosition !== 'NOT_STATED') {
    return { roadPosition: finding.roadPosition as RoadPosition, note: body.slice(0, 500) };
  }
  return { note: body.slice(0, 500) };
}
