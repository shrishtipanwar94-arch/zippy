// WHAT DEMO MODE HIDES, AND THAT IT HIDES NOTHING WHEN OFF (src/demo/demoScope.ts).
//
// Every read that feeds the solver or the dispatcher adds one of these
// clauses. The property that matters most is the second describe: with the
// flag off each clause is {}, so the main seed, the tests and local
// development see exactly what they saw before demo mode existed.

import { describe, expect, it } from 'vitest';
import {
  demoDepotWhere,
  demoJobWhere,
  demoTechnicianWhere,
  demoUnitWhere,
  demoWorkshopWhere,
} from '../src/demo/demoScope.js';
import { DEMO_CREWS, DEMO_REFERENCE_DRIVER, DEMO_TENANT_ID } from '../src/demo/demoCrews.js';

describe('in demo mode', () => {
  it('shows the demo tenant\'s live jobs plus the reference job', () => {
    expect(demoJobWhere(true)).toEqual({
      tenantId: DEMO_TENANT_ID,
      OR: [
        { status: { notIn: ['RESOLVED', 'CANCELLED', 'UNSERVICEABLE'] } },
        { vehicle: { registration: DEMO_REFERENCE_DRIVER.registration } },
      ],
    });
  });

  it('shows only the four demo crews', () => {
    expect(demoUnitWhere(true)).toEqual({ code: { in: DEMO_CREWS.map((crew) => crew.unitCode) } });
    expect(demoTechnicianWhere(true)).toEqual({
      employeeCode: { in: DEMO_CREWS.map((crew) => crew.employeeCode) },
    });
  });

  it('shows no depot, so crew C cannot fetch the part it is meant to lack', () => {
    expect(demoDepotWhere(true)).toEqual({ id: { in: [] } });
  });

  it('shows only the demo workshop', () => {
    expect(demoWorkshopWhere(true)).toEqual({ code: 'WS-DMO' });
  });
});

describe('outside demo mode', () => {
  it('adds no condition at all', () => {
    expect(demoJobWhere(false)).toEqual({});
    expect(demoUnitWhere(false)).toEqual({});
    expect(demoTechnicianWhere(false)).toEqual({});
    expect(demoDepotWhere(false)).toEqual({});
    expect(demoWorkshopWhere(false)).toEqual({});
  });
});
