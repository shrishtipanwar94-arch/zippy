-- The balance order a driver pays when the approved total exceeds the callout
-- already held. See the comment on Payment.balanceOrderRef in schema.prisma.
ALTER TABLE "payments" ADD COLUMN "balance_order_ref" TEXT;
