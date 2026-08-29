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
  nearestExit: z.string().max(120).nullable().default(null),
  kmMarker: z.string().max(40).nullable().default(null),
  landmark: z.string().max(200).nullable().default(null),
  roadPosition: z.enum(ROAD_POSITIONS).nullable().default(null),
  parkingLevel: z.string().max(40).nullable().default(null),
  onHighway: z.boolean().default(false),
});

export type LocationInput = z.infer<typeof locationSchema>;

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
    onHighway: location.onHighway,
  };
}
