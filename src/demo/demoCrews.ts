// THE DEMO BOARD'S CAST — who is on it, where they stand, what they can do.
//
// Plain data with no database access, shared by two callers that run in
// different processes: prisma/seed/demoBoard.ts writes these rows when the web
// process boots, and src/demo/refreshDemoShifts.ts keeps their shifts current
// from the worker. Both have to agree on exactly which rows are demo rows, so
// that list lives once, here, in src/ where the compiled worker can import it.
//
// WHY FOUR CREWS AND NOT ONE. With a single van the solver has nothing to
// decide: the van is feasible or it is not. Four crews, each wrong in a
// different way, put a real choice on screen for a flat battery (the demo's
// job needs JUMP_START and BATTERY_REPLACEMENT, and no tow):
//
//   A  nearest, but can only jump-start         -> rejected CAPABILITY_MISSING
//   B  a little further, can do both, battery on board -> the one that wins
//   C  a tow crew with both skills, no battery  -> rejected PART_UNAVAILABLE
//   D  far away, can do everything, stocked     -> feasible, but costs more
//
// scripts/demo-dry-check.ts runs the real engine against this board and exits
// non-zero if B is not the crew the solver chooses.

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
};

// WHERE THE DRIVER IS. The driver form's coordinate boxes default to exactly
// this point (public/driver.html), and DEMO.md tells the presenter to leave
// them alone — so "closest to the driver" is measured from here.
// Connaught Place, the same centroid the main seed's first zone uses.
export const DEMO_DRIVER_LOCATION = { lat: 28.6152, lng: 77.2095 };

export const DEMO_ZONE = {
  id: 'demo-zone',
  code: 'DMO',
  name: 'Demo Zone',
  // Wide enough to take in Hauz Khas to the south, where crew D waits.
  boundary: { type: 'bbox', minLat: 28.54, maxLat: 28.65, minLng: 77.175, maxLng: 77.245 },
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
  },
  {
    // ~1.9 km, at Gole Market. Can jump-start AND replace a battery, and
    // carries one, so it covers both contending faults.
    label: 'B',
    technicianId: 'demo-technician-b',
    userId: 'demo-user-tech-b',
    email: 'demo-tech-b@zippy.internal',
    name: 'Ravi Kumar',
    employeeCode: 'DMO-TB',
    unitId: 'demo-unit-b',
    unitCode: 'DMO-VB',
    unitKind: 'VAN',
    lat: 28.63,
    lng: 77.2,
    capabilities: ['JUMP_START', 'BATTERY_REPLACEMENT'],
    stockedSkus: ['BAT-45AH'],
  },
  {
    // ~1.5 km, towards Barakhamba Road. A tow crew: FLATBED_LOADING needs a
    // flatbed, so this unit is a FLATBED_TOW rather than a van. Trained for
    // both battery jobs but carrying no battery, and the demo board has no
    // depot to fetch one from, so the parts layer rejects it.
    label: 'C',
    technicianId: 'demo-technician-c',
    userId: 'demo-user-tech-c',
    email: 'demo-tech-c@zippy.internal',
    name: 'Gurpreet Singh',
    employeeCode: 'DMO-TC',
    unitId: 'demo-unit-c',
    unitCode: 'DMO-VC',
    unitKind: 'FLATBED_TOW',
    lat: 28.6255,
    lng: 77.2195,
    capabilities: ['JUMP_START', 'BATTERY_REPLACEMENT', 'FLATBED_LOADING'],
    stockedSkus: [],
  },
  {
    // ~7.4 km, at Hauz Khas. Can do everything a non-starting car might need
    // and carries the parts for all of it, so it covers 96% of the fault mass
    // against B's 80% — and the cost function genuinely values that, because
    // a crew that can fix the alternator too saves a second callout.
    //
    // HOW FAR IS FAR ENOUGH WAS MEASURED, not guessed. At ~4.4 km (Sarojini
    // Nagar, the first position tried) D WON on real roads: OSRM put it only
    // 3.5 minutes behind B, and its coverage was worth more than that. Under
    // haversine B won by under 2 cost points — a margin a presenter's pin
    // moved a few hundred metres could flip. Here B wins under both.
    label: 'D',
    technicianId: 'demo-technician-d',
    userId: 'demo-user-tech-d',
    email: 'demo-tech-d@zippy.internal',
    name: 'Meera Nair',
    employeeCode: 'DMO-TD',
    unitId: 'demo-unit-d',
    unitCode: 'DMO-VD',
    unitKind: 'VAN',
    lat: 28.5494,
    lng: 77.2001,
    capabilities: ['JUMP_START', 'BATTERY_REPLACEMENT', 'ALTERNATOR_REPLACEMENT', 'OBD_DIAGNOSTICS'],
    stockedSkus: ['BAT-45AH', 'ALT-RECON', 'DRIVE-BELT', 'STR-MOTOR-RECON'],
  },
];

// How many of each stocked part a demo van carries after a refresh.
export const DEMO_STOCK_QUANTITY = 2;

export const DEMO_TECHNICIAN_IDS: string[] = DEMO_CREWS.map((crew) => crew.technicianId);
export const DEMO_UNIT_IDS: string[] = DEMO_CREWS.map((crew) => crew.unitId);
