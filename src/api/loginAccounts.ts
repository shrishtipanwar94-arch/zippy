// GET /login/accounts — WHICH ACCOUNTS THE SIGN-IN FORMS OFFER.
//
// With DEMO_MODE on, exactly three: the demo dispatcher, the demo driver and
// crew B's technician. Each page fills its email box from this list
// (public/js/loginHints.js), so a presenter never has to type an address and
// never sees one that is not part of the demo. Crews A, C and D are real
// technicians on the board but are deliberately absent: they have no usable
// password (prisma/seed/devPassword.ts, unusablePasswordHash).
//
// With DEMO_MODE off the list is empty and the pages keep the main seed's
// prefilled accounts, unchanged.
//
// NO PASSWORDS, EVER. This route is public — it has to be, it runs before
// anyone has signed in — so it names accounts and nothing else.

import { Router } from 'express';
import { config } from '../infra/config.js';
import { DEMO_CREWS, DEMO_DISPATCHER, DEMO_DRIVER } from '../demo/demoCrews.js';

export type LoginAccount = { page: 'dispatcher' | 'driver' | 'technician'; email: string; name: string };

export function visibleAccounts(demoMode: boolean): LoginAccount[] {
  if (!demoMode) return [];

  const accounts: LoginAccount[] = [
    { page: 'dispatcher', email: DEMO_DISPATCHER.email, name: DEMO_DISPATCHER.name },
    { page: 'driver', email: DEMO_DRIVER.email, name: DEMO_DRIVER.name },
  ];
  for (const crew of DEMO_CREWS) {
    if (crew.canSignIn) accounts.push({ page: 'technician', email: crew.email, name: crew.name });
  }
  return accounts;
}

export const loginAccountsRouter = Router();

loginAccountsRouter.get('/login/accounts', (_req, res) => {
  res.json({ demoMode: config.demoMode, accounts: visibleAccounts(config.demoMode) });
});
