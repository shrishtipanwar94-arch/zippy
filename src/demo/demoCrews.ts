// THE DEMO BOARD'S CAST — who is on it, where they stand, what they can do.
//
// Plain data with no database access, shared by callers in different
// processes: prisma/seed/demoBoard.ts writes these rows when the web process
// boots, src/demo/refreshDemoShifts.ts keeps them current from the worker, and
// src/demo/demoScope.ts hides everything that is NOT on this list while
// DEMO_MODE is on. All three have to agree on exactly which rows are demo rows,
// so that list lives once, here, in src/ where the compiled worker can import it.
//
// ONE CREW WINS EVERYTHING, THREE LOSE FOR A REASON YOU CAN SEE. Crew B can do
// every fault the driver screen can report and carries every part, so whatever
// the driver reports, B is the answer — and only B has a login, so the demo
// always lands on the one technician screen the presenter has open. The other
// three are on the board so the dispatcher's candidate table has something to
// say:
//
//   A  nearest, but can only jump-start          -> CAPABILITY_MISSING
//   B  everything, every part, a flatbed so it can tow too      -> chosen
//   C  every skill, NO stock, a little further   -> PART_UNAVAILABLE where a
//      part is needed; loses on distance where none is
//   D  everything, every part, far away          -> feasible, costs more
//
// B AND D ARE FLATBEDS because one fault (IMMOBILISED_UNKNOWN) needs a tow, and
// feasibility rejects a van for any tow job (VEHICLE_TYPE_INCOMPATIBLE). Nothing
// in the cost function looks at the vehicle kind, and the driver screen never
// reports a basement (the one place a flatbed is barred), so a flatbed loses
// nothing on the other faults.
//
// scripts/demo-dry-check.ts runs the real engine for every fault type and exits
// non-zero if B is not the crew chosen.

import { FAULT_CODES, capabilitiesForFault, partSkusForFault } from '../domain/faults.js';

export type DemoUnitKind = 'VAN' | 'FLATBED_TOW';

export type DemoCrew = {
  label: 'A' | 'B' | 'C' | 'D';
  technicianId: string;
  userId: string;
  email: string;
  // A real first name, because the driver is shown one: "Ravi is on the way".
  name: string;
  employeeCode: string;
  unitId: string;
  unitCode: string;
  unitKind: DemoUnitKind;
  // Where the van waits. Every position is inside the demo zone's boundary.
  lat: number;
  lng: number;
  // Granted to BOTH the technician and the unit, because candidate generation
  // intersects the two — a skill only counts if the van carries the kit for it.
  capabilities: string[];
  stockedSkus: string[];
  // Only B can be signed in to. A, C and D are real technicians on the board,
  // but their accounts get a password nobody knows and are never listed.
  canSignIn: boolean;
};

// Every capability and every part any fault needs, read from the same tables
// dispatch and estimates use (src/domain/faults.ts), so a fault added there is
// automatically covered by crew B rather than silently lost to it.
function everyCapability(): string[] {
  const codes = new Set<string>();
  for (const fault of FAULT_CODES) {
    for (const code of capabilitiesForFault(fault)) codes.add(code);
  }
  return [...codes].sort();
}

function everyPart(): string[] {
  const skus = new Set<string>();
  for (const fault of FAULT_CODES) {
    for (const sku of partSkusForFault(fault)) skus.add(sku);
  }
  return [...skus].sort();
}

export const ALL_CAPABILITIES: string[] = everyCapability();
export const ALL_PARTS: string[] = everyPart();

// WHERE THE DRIVER IS. The driver form's coordinate boxes default to exactly
// this point (public/driver.html), so "closest to the driver" is measured from
// here. Connaught Place, the same centroid the main seed's first zone uses.
export const DEMO_DRIVER_LOCATION = { lat: 28.6152, lng: 77.2095 };

export const DEMO_ZONE = {
  id: 'demo-zone',
  code: 'DMO',
  name: 'Demo Zone',
  // Wide enough to take in Hauz Khas to the south, where crew D waits.
  boundary: { type: 'bbox', minLat: 28.54, maxLat: 28.65, minLng: 77.175, maxLng: 77.26 },
};

export const DEMO_TENANT_ID = 'demo-tenant';

export const DEMO_DISPATCHER = {
  userId: 'demo-user-dispatcher',
  email: 'demo-dispatcher@zippy.internal',
  name: 'Demo Dispatcher',
};

export const DEMO_DRIVER = {
  userId: 'demo-user-driver',
  driverId: 'demo-driver',
  membershipId: 'demo-membership-driver',
  vehicleId: 'demo-vehicle',
  profileId: 'demo-profile',
  email: 'demo-driver@zippy.internal',
  name: 'Asha Rao',
  registration: 'DL01DM0001',
};

// THE REFERENCE JOB'S DRIVER — a second demo driver with no login.
//
// The dispatcher's board in demo mode shows the job the presenter creates live
// and one earlier job, so the screen is not empty before the demo starts. That
// earlier job needs a driver and a car of its own: on the presenter's driver
// account it would sit in her job list. No password, never listed.
export const DEMO_REFERENCE_DRIVER = {
  userId: 'demo-user-reference-driver',
  driverId: 'demo-reference-driver',
  membershipId: 'demo-membership-reference-driver',
  vehicleId: 'demo-reference-vehicle',
  email: 'demo-reference-driver@zippy.internal',
  name: 'Vikram Mehta',
  registration: 'DL01DM0002',
};

// THE ONE DESTINATION ON THE BOARD, for the tow fault. Open around the clock and
// authorised for the demo car's brand, so a tow job is never refused for
// opening hours during an evening demo.
export const DEMO_WORKSHOP = {
  id: 'demo-workshop',
  code: 'WS-DMO',
  name: 'Karol Bagh Auto Works',
  lat: 28.6517,
  lng: 77.1907,
  brands: ['MARUTI_SUZUKI', 'HYUNDAI', 'TATA'],
};

// Distances are straight-line from DEMO_DRIVER_LOCATION.
export const DEMO_CREWS: DemoCrew[] = [
  {
    // ~0.6 km, on Janpath. The nearest crew, and the one a naive "send the
    // closest van" rule would pick — which is exactly why it is here.
    label: 'A',
    technicianId: 'demo-technician-a',
    userId: 'demo-user-tech-a',
    email: 'demo-tech-a@zippy.internal',
    name: 'Imran Sheikh',
    employeeCode: 'DMO-TA',
    unitId: 'demo-unit-a',
    unitCode: 'DMO-VA',
    unitKind: 'VAN',
    lat: 28.62,
    lng: 77.212,
    capabilities: ['JUMP_START'],
    stockedSkus: [],
    canSignIn: false,
  },
  {
    // ~1.9 km, at Gole Market. Every skill, every part — the answer to anything
    // the driver can report.
    label: 'B',
    technicianId: 'demo-technician-b',
    userId: 'demo-user-tech-b',
    email: 'demo-tech-b@zippy.internal',
    name: 'Ravi Kumar',
    employeeCode: 'DMO-TB',
    unitId: 'demo-unit-b',
    unitCode: 'DMO-VB',
    unitKind: 'FLATBED_TOW',
    lat: 28.63,
    lng: 77.2,
    capabilities: ALL_CAPABILITIES,
    stockedSkus: ALL_PARTS,
    canSignIn: true,
  },
  {
    // ~3.3 km, at Pragati Maidan. Every skill, nothing on board, and the demo
    // board has no depot to fetch from — so the parts layer rejects it for any
    // fault that consumes a part. It sits further out than B on purpose: for
    // the two faults that consume nothing (a lockout, a tow) it is feasible,
    // and loses on distance instead.
    label: 'C',
    technicianId: 'demo-technician-c',
    userId: 'demo-user-tech-c',
    email: 'demo-tech-c@zippy.internal',
    name: 'Gurpreet Singh',
    employeeCode: 'DMO-TC',
    unitId: 'demo-unit-c',
    unitCode: 'DMO-VC',
    unitKind: 'FLATBED_TOW',
    lat: 28.618,
    lng: 77.243,
    capabilities: ALL_CAPABILITIES,
    stockedSkus: [],
    canSignIn: false,
  },
  {
    // ~7.4 km, at Hauz Khas. As capable as B and as well stocked — feasible for
    // everything, and the crew a job requeues to when B declines. Distance is
    // its only disadvantage.
    label: 'D',
    technicianId: 'demo-technician-d',
    userId: 'demo-user-tech-d',
    email: 'demo-tech-d@zippy.internal',
    name: 'Meera Nair',
    employeeCode: 'DMO-TD',
    unitId: 'demo-unit-d',
    unitCode: 'DMO-VD',
    unitKind: 'FLATBED_TOW',
    lat: 28.5494,
    lng: 77.2001,
    capabilities: ALL_CAPABILITIES,
    stockedSkus: ALL_PARTS,
    canSignIn: false,
  },
];

// How many of each stocked part a demo van carries after a refresh.
export const DEMO_STOCK_QUANTITY = 2;

export const DEMO_TECHNICIAN_IDS: string[] = DEMO_CREWS.map((crew) => crew.technicianId);
export const DEMO_UNIT_IDS: string[] = DEMO_CREWS.map((crew) => crew.unitId);
