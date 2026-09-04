// POSTING A MESSAGE — the conversation, the message, its deliveries, its
// attachment, and the promotions it raises, in one transaction.
//
// SCOPED TIGHTLY, ON PURPOSE. Conversation, Message, MessageDelivery,
// Attachment. No typing indicators and no read receipts — those are where
// messaging balloons, they double the write volume of a chat, and neither
// changes a dispatch decision. The brief rules them out and so does this file.
//
// A MESSAGE IS NOT A JOB EVENT. It does not go in `job_events`, it has no
// sequence, and it does not reach the dispatcher's incident timeline. Chat is
// unstructured chatter until a human promotes part of it, and the whole point
// of Phase 15b is the gap between the two. Mixing them would erase it.
//
// DELIVERIES ARE ROWS, NOT ACKNOWLEDGEMENTS. One per recipient, written here as
// QUEUED and marked SENT when the socket fan-out has run. That is a record of
// what we ATTEMPTED, which is what an operator asking "did the driver get
// told?" actually needs. It is deliberately not a read receipt: nothing on any
// client reports back.

import type { Prisma, PrismaClient } from '@prisma/client';
import { classifyMessage, locationShareClassification } from '../domain/messageClassifier.js';
import type { Classification } from '../domain/messageClassifier.js';
import { flagPromotions } from '../commit/eventPromotions.js';

export type PostMessageInput = {
  jobId: string;
  senderRole: string;
  senderId: string | null;
  body: string;
  // TEXT is a typed message. LOCATION carries coordinates from the driver's
  // "send my exact location" tap. PHOTO carries one image.
  kind: 'TEXT' | 'LOCATION' | 'PHOTO';
  coordinates?: { lat: number; lng: number };
  // How good the phone said the fix was, and which way the vehicle was
  // pointing. Both optional: a driver who typed their position has neither.
  accuracyMetres?: number;
  headingDegrees?: number;
  photo?: { url: string; sizeBytes: number };
  // Classifications the caller already computed, because the model that helps
  // produce them must not be called from inside this transaction. Omitted, the
  // rule table runs here as it always did.
  classifications?: Classification[];
  at?: Date;
};

export type PostedMessage = {
  messageId: string;
  conversationId: string;
  promotionIds: string[];
  recipientUserIds: string[];
};

export async function postMessage(
  db: PrismaClient,
  input: PostMessageInput,
): Promise<PostedMessage> {
  const at = input.at ?? new Date();
  const classifications = classificationsFor(input);

  return db.$transaction(async (tx) => {
    const conversationId = await ensureConversation(tx, input.jobId);

    const message = await tx.message.create({
      data: {
        conversationId,
        senderRole: input.senderRole,
        senderId: input.senderId,
        body: input.body,
        kind: input.kind,
        // The phone's clock and ours. A message typed in a tunnel and sent on
        // reconnect happened before we heard about it, the same split
        // `technician_actions` records.
        eventTime: at,
      },
      select: { id: true },
    });

    if (input.photo) {
      await tx.attachment.create({
        data: {
          messageId: message.id,
          kind: 'PHOTO',
          url: input.photo.url,
          sizeBytes: input.photo.sizeBytes,
        },
      });
    }

    if (input.coordinates) {
      // A REPORT, NOT A MOVE. The coordinates are recorded as something the
      // driver said, exactly as intake records the position they first gave.
      // Whether the JOB moves to them is the promotion's decision, not this
      // one — see eventPromotions.ts.
      await tx.locationEvent.create({
        data: {
          jobId: input.jobId,
          lat: input.coordinates.lat,
          lng: input.coordinates.lng,
          // The two fields that make this more than a pin. See src/api/chat.ts.
          accuracyMetres: input.accuracyMetres ?? null,
          headingDegrees: input.headingDegrees ?? null,
          source: 'CHAT',
          eventTime: at,
        },
      });
    }

    const recipientUserIds = await recipientsFor(tx, input.jobId, input.senderId);
    for (const recipientId of recipientUserIds) {
      await tx.messageDelivery.create({
        data: { messageId: message.id, recipientId, channel: 'SOCKET', status: 'QUEUED' },
      });
    }

    const promotionIds = await flagPromotions(tx, {
      jobId: input.jobId,
      messageId: message.id,
      classifications,
    });

    return { messageId: message.id, conversationId, promotionIds, recipientUserIds };
  });
}

// A structured location tap classifies itself; a typed message goes through the
// rule table. Both end up as the same kind of proposal, which is what keeps the
// confirmation path single.
function classificationsFor(input: PostMessageInput): Classification[] {
  if (input.coordinates) {
    return [locationShareClassification(input.coordinates, input.accuracyMetres)];
  }
  if (input.kind === 'PHOTO') return [];
  // Already classified by the caller, which is how the Phase 16 model gets a
  // word in without a network call happening inside this transaction. The rule
  // table is already folded into that list (src/ai/classifyMessage.ts) — it is
  // never skipped, only added to.
  if (input.classifications) return input.classifications;
  return classifyMessage(input.body);
}

// One conversation per job, created on first use rather than at intake — most
// jobs never generate a message, and a table of empty conversations is a table
// of rows nobody reads.
//
// `job_id` is UNIQUE, so two people typing simultaneously into a job with no
// conversation race here. The constraint arbitrates: the loser's create fails,
// and because both are inside the caller's transaction the loser's whole
// message write rolls back and is retried by the client. Read-then-create with
// no constraint would give the job two conversations and split its history.
async function ensureConversation(tx: Prisma.TransactionClient, jobId: string): Promise<string> {
  const existing = await tx.conversation.findUnique({ where: { jobId }, select: { id: true } });
  if (existing) return existing.id;

  const created = await tx.conversation.create({ data: { jobId }, select: { id: true } });
  return created.id;
}

// Who else is on this job. The driver who raised it and the technician assigned
// to it — dispatchers are not enumerated here because they are a role watching
// a board, not a named recipient, and writing a delivery row per dispatcher per
// message would be a row count that grows with staffing rather than with
// conversation.
async function recipientsFor(
  tx: Prisma.TransactionClient,
  jobId: string,
  senderId: string | null,
): Promise<string[]> {
  const job = await tx.job.findUnique({
    where: { id: jobId },
    select: {
      driver: { select: { userId: true } },
      assignedTechnician: { select: { userId: true } },
    },
  });
  if (!job) return [];

  const everyone = [job.driver?.userId, job.assignedTechnician?.userId];
  return [...new Set(everyone.filter((id): id is string => Boolean(id) && id !== senderId))];
}

// Called after the socket fan-out has run. Best-effort and idempotent: marking
// an already-sent delivery sent again changes nothing.
export async function markDeliveriesSent(db: PrismaClient, messageId: string): Promise<void> {
  await db.messageDelivery.updateMany({
    where: { messageId, status: 'QUEUED' },
    data: { status: 'SENT', sentAt: new Date() },
  });
}
