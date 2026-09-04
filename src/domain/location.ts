// WHERE THE VEHICLE IS — precisely enough to send someone to it.
//
// This is a feasibility input, not a UX nicety. Two things here matter more
// than the coordinates:
//
// CARRIAGEWAY DIRECTION is first-class. A unit 200 metres away in a straight
// line, on the opposite carriageway of a divided highway, is 20km away by road
// — it has to run to the next interchange and come back. Phase 7's feasibility
// filter will reject those candidates outright, and it can only do that if the
// direction the vehicle was travelling was captured at intake. Retrofitting it
// later means every historical job is unusable for evaluation.
//
// ROAD POSITION drives both safety triage and what kind of unit can even park:
// a vehicle in a live lane needs a different response from one in a basement
// car park, and a flatbed cannot reach the second at all.

import { z } from 'zod';
import type { RoadPosition } from '@prisma/client';

export const ROAD_POSITIONS = ['SHOULDER', 'LANE', 'SERVICE_ROAD', 'PARKING'] as const;

export const CARRIAGEWAY_DIRECTIONS = [
  'NORTHBOUND',
  'EASTBOUND',
  'SOUTHBOUND',
  'WESTBOUND',
] as const;

export type CarriagewayDirection = (typeof CARRIAGEWAY_DIRECTIONS)[number];

export const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  // Compass bearing the vehicle was travelling in, 0 = north. Null when the
  // driver's phone gave no heading and they could not say.
  headingDegrees: z.number().int().min(0).max(359).nullable().default(null),
  // HOW GOOD THE FIX WAS, in metres, as the phone reported it. Optional because
  // a driver who typed their coordinates has no accuracy to report, and a
  // dispatcher taking the position down a phone line has none either.
  //
  // It is kept because it changes what anyone can do with the position: eight
  // metres puts a van at the right car, nine hundred puts it in the right
  // neighbourhood, and until now the two arrived looking identical. It is
  // recorded on the LocationEvent rather than on the job, because it describes
  // one REPORT rather than the job's current location — a later, better fix
  // should not inherit the confidence of an earlier, worse one.
  accuracyMetres: z.number().min(0).max(100000).nullable().default(null),
  nearestExit: z.string().max(120).nullable().default(null),
  kmMarker: z.string().max(40).nullable().default(null),
  landmark: z.string().max(200).nullable().default(null),
  roadPosition: z.enum(ROAD_POSITIONS).nullable().default(null),
  parkingLevel: z.string().max(40).nullable().default(null),
  // STRICT, so an unknown key is a 400 rather than a silent strip. A client
  // still sending the old `onHighway` field is told plainly that it is not
  // theirs to set, instead of having it dropped and wondering why the safety
  // level disagrees with it. Quietly ignoring a field the caller believes
  // matters is how the original bug survived three phases.
}).strict();

export type LocationInput = z.infer<typeof locationSchema>;

// ONE FACT, ONE HOME.
//
// "Is this vehicle on a highway" used to be its own field, supplied by the
// client, on BOTH the location payload and the safety context. A client that
// filled in one and not the other got a job whose location column said highway
// and whose safety level said nothing unusual — and because safety level sits
// in a lexicographic ordering above the cost function, that is the one input
// that must never be quietly wrong. So it is no longer an input at all. It is
// derived, here, from the position the driver reported, and that single derived
// value feeds both the stored column and the safety triage.
//
// The honest limit of this rule: it conflates "beside live traffic" with "on a
// highway". A car blocking a lane of a city street is LANE, and this will call
// it a highway. That direction is the safe one — it over-triages rather than
// under-triages — and `trafficSpeedKph` in the safety report is the finer
// signal that separates the two. Worth revisiting when the road network is
// real (Phase 6, OSRM), which is the first point at which the road class is
// actually knowable rather than inferred.
const HIGHWAY_POSITIONS: ReadonlySet<string> = new Set(['SHOULDER', 'LANE']);

// An unstated position is NOT a highway — but nor is it treated as safe. This
// answers only "did the driver tell us they are on one", and the absence of an
// answer is picked up separately by the UNKNOWN_POSITION safety rule, which
// raises the job to ELEVATED. Returning false here is therefore honest rather
// than optimistic: the claim is not being made, and the missing answer is
// handled where risk is decided.
export function isOnHighway(roadPosition: RoadPosition | null): boolean {
  if (roadPosition === null) return false;
  return HIGHWAY_POSITIONS.has(roadPosition);
}

// A compass bearing collapsed to the carriageway it implies. Four buckets, not
// eight: what matters downstream is only "is the unit on the same side of the
// divider", and a divided road has two sides.
export function carriagewayFromHeading(headingDegrees: number | null): CarriagewayDirection | null {
  if (headingDegrees === null) return null;

  const heading = ((headingDegrees % 360) + 360) % 360;
  if (heading < 45 || heading >= 315) return 'NORTHBOUND';
  if (heading < 135) return 'EASTBOUND';
  if (heading < 225) return 'SOUTHBOUND';
  return 'WESTBOUND';
}

// The columns the Job row carries. Kept as one function so the route, the
// simulator and any later importer all write the same shape.
export type LocationColumns = {
  lat: number;
  lng: number;
  headingDegrees: number | null;
  carriagewayDirection: CarriagewayDirection | null;
  nearestExit: string | null;
  kmMarker: string | null;
  landmark: string | null;
  roadPosition: RoadPosition | null;
  parkingLevel: string | null;
  onHighway: boolean;
};

export function locationColumns(location: LocationInput): LocationColumns {
  return {
    lat: location.lat,
    lng: location.lng,
    headingDegrees: location.headingDegrees,
    carriagewayDirection: carriagewayFromHeading(location.headingDegrees),
    nearestExit: location.nearestExit,
    kmMarker: location.kmMarker,
    landmark: location.landmark,
    roadPosition: location.roadPosition,
    parkingLevel: location.parkingLevel,
    onHighway: isOnHighway(location.roadPosition),
  };
}
