-- PHASE 22b — the Razorpay adapter.
--
-- Four changes, and the interesting one is the third.
--
-- 1. AN ORDER IS NOT AN AUTHORISATION. Razorpay's flow has two objects with
--    two lifetimes: an ORDER exists the moment we ask for money, before anyone
--    has touched a card, and a PAYMENT exists only once the customer has
--    actually paid. `payments.external_ref` already held the authorisation;
--    `gateway_order_ref` holds the order. One column for both would make
--    "waiting on the customer" indistinguishable from "the money is held",
--    which are the two states this whole phase is about telling apart.
ALTER TABLE "payments" ADD COLUMN "gateway_order_ref" TEXT;
CREATE INDEX "payments_gateway_order_ref_idx" ON "payments" ("gateway_order_ref");

-- 2. WHERE A PAYOUT WOULD GO, and what happened when we tried. The bank
--    account itself is never stored — a RazorpayX fund account id stands in
--    for it, the same way no card detail is stored anywhere in this schema.
ALTER TABLE "technicians" ADD COLUMN "payout_fund_account_ref" TEXT;
ALTER TABLE "payouts"
  ADD COLUMN "provider_ref" TEXT,
  ADD COLUMN "failure_reason" TEXT,
  ADD COLUMN "sent_at" TIMESTAMP(3);

-- 3. THE GATEWAY'S OWN EVENT LOG, and the unique index that makes a webhook
--    exactly-once.
--
--    Razorpay redelivers a webhook until it gets a 2xx, so the same event id
--    arriving three times is normal operation rather than an error. The row
--    below is inserted in the SAME transaction as the state change it causes,
--    so a redelivery collides here and the whole transaction rolls back — the
--    duplicate cannot apply half of anything.
--
--    Kept apart from `idempotency_keys` because they answer different
--    questions: that table is keyed by (user, scope, key) and dedupes a
--    CLIENT's retry; this one is keyed by the gateway's event id and dedupes a
--    VENDOR's redelivery. There is no user to scope a webhook by.
--
--    `payment_id` and `payout_id` are nullable, and that is the point: an
--    event we cannot match to a local row is precisely the divergence the
--    reconciliation worker exists to close, so it is stored as evidence rather
--    than dropped.
CREATE TABLE "gateway_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payment_id" TEXT,
    "payout_id" TEXT,
    "outcome" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "event_time" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gateway_events_provider_event_id_key"
  ON "gateway_events" ("provider", "event_id");
CREATE INDEX "gateway_events_payment_id_idx" ON "gateway_events" ("payment_id");
CREATE INDEX "gateway_events_outcome_idx" ON "gateway_events" ("outcome");
