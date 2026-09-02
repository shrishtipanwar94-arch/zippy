// WHICH PROVIDER THIS PROCESS USES, decided once at startup and nowhere else.
//
// Both always-on processes call this: the web process authorises and captures
// from routes, the worker process does the same from the retry sweep and the
// reconciliation worker, and a provider installed in only one of them would
// make the two disagree about where money lives.
//
// THE STUB IS THE DEFAULT AND STAYS THE DEFAULT. With no keys configured
// nothing changes: every settlement rule still runs against
// src/payments/stubProvider.ts, `npm run test:fast` still proves what a
// cancellation costs without a network, and dispatch is unaffected either way.
// A payment vendor is not a startup dependency of a breakdown service.

import { logger } from '../infra/logger.js';
import { isRazorpayConfigured } from './razorpayClient.js';
import { razorpayProvider } from './razorpayProvider.js';
import { setPaymentProvider } from './stubProvider.js';

export function installConfiguredPaymentProvider(): void {
  if (!isRazorpayConfigured()) {
    logger.info('no razorpay credentials; payments run against the stub provider');
    return;
  }
  setPaymentProvider(razorpayProvider);
  logger.info('razorpay test-mode provider installed');
}
