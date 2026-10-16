// THE SIGN-IN FORMS OFFER EXACTLY THREE ACCOUNTS IN DEMO MODE, AND NONE OF
// THEM IS CREW A, C OR D (src/api/loginAccounts.ts).
//
// Crews A, C and D are real technicians the solver weighs, but the demo is
// built so that every job lands on crew B — the one technician screen the
// presenter has open. Outside demo mode the list is empty, so the pages keep
// the main seed's prefilled accounts exactly as before.

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { visibleAccounts } from '../src/api/loginAccounts.js';
import { createApp } from '../src/api/app.js';

describe('visibleAccounts', () => {
  it('lists the demo dispatcher, the demo driver and crew B, one per page', () => {
    const accounts = visibleAccounts(true);
    expect(accounts.map((account) => account.email)).toEqual([
      'demo-dispatcher@zippy.internal',
      'demo-driver@zippy.internal',
      'demo-tech-b@zippy.internal',
    ]);
    expect(accounts.map((account) => account.page)).toEqual(['dispatcher', 'driver', 'technician']);
  });

  it('never lists crews A, C or D', () => {
    const emails = visibleAccounts(true).map((account) => account.email);
    for (const hidden of ['demo-tech-a@zippy.internal', 'demo-tech-c@zippy.internal', 'demo-tech-d@zippy.internal']) {
      expect(emails).not.toContain(hidden);
    }
  });

  it('lists nothing outside demo mode, so the pages keep their defaults', () => {
    expect(visibleAccounts(false)).toEqual([]);
  });
});

describe('GET /login/accounts', () => {
  it('is public and carries no passwords', async () => {
    const response = await request(createApp()).get('/login/accounts');
    expect(response.status).toBe(200);
    // The suite runs with DEMO_MODE unset.
    expect(response.body).toEqual({ demoMode: false, accounts: [] });
    expect(JSON.stringify(response.body)).not.toMatch(/password/i);
  });
});
