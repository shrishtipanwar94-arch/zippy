// The four queues the build plan names, plus one that is not a business
// queue: DEAD_LETTER is where a job goes after it has exhausted every retry,
// so an operator has somewhere to look rather than a silent drop. It is a
// destination, never something application code enqueues work onto directly.

export const QUEUE_NAMES = ['solver', 'offer-expiry', 'notification', 'cleanup'] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export const DEAD_LETTER_QUEUE_NAME = 'dead-letter';
