// WHO HEARS WHAT. Three room types, and the rules for which of them a given
// caller is allowed into.
//
// A Socket.IO "room" is just a named set of sockets — you emit to the name and
// everyone in it receives once. It carries no security of its own: a room is
// only private because nothing put the wrong socket in it. So the decision of
// which rooms a connection may join is the whole access-control story for the
// realtime layer, and it lives here as pure functions rather than inline in the
// connection handler.
//
//   job:<jobId>       the driver who raised it, the assigned technician,
//                     and dispatchers. The narrow one — everything about a
//                     single breakdown.
//   zone:<zoneId>     dispatchers. A dispatcher watches a geography, not a job.
//   tenant:<tenantId> fleet managers. A fleet manager watches their fleet.
//   technician:<id>   one technician, for the events that must reach them
//                     BEFORE they have any connection to the job. See
//                     `technicianRoomForEvent`.
//
// A socket can sit in several at once, and the fan-out point emits to all three
// for one event. Socket.IO de-duplicates across rooms — a dispatcher in both
// the job room and the zone room receives the event once, not twice.

import type { Role } from '@prisma/client';
import type { AuthContext } from '../auth/context.js';

export function jobRoom(jobId: string): string {
  return `job:${jobId}`;
}

export function zoneRoom(zoneId: string): string {
  return `zone:${zoneId}`;
}

export function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

export function technicianRoom(technicianId: string): string {
  return `technician:${technicianId}`;
}

// Rooms a connection joins the moment it authenticates, with no request from
// the client. These are the standing subscriptions a role has by virtue of
// being that role.
//
// A DRIVER gets none: their interest is per-job, they can only be in rooms for
// jobs that are theirs, and which jobs those are changes over the life of the
// connection. They subscribe explicitly, one job at a time, and each
// subscription is authorised against the database.
//
// A TECHNICIAN GETS ONE, AND IT IS NOT A CONVENIENCE. Their first contact with
// a job is an offer, which lives forty-five seconds — and until that offer they
// have no reason to be in that job's room, because the job is not theirs and
// `mayRequestJobRoom` would refuse them. The page subscribed only to jobs a
// `/technician/work` fetch had already returned, and re-fetched only when a
// job event arrived, so the first offer for any job could not arrive: no room,
// no event, no refetch, and no polling behind it. Every first offer expired
// unseen. One room per technician, joined on connect, breaks that circle.
export function standingRoomsFor(context: AuthContext, allZoneIds: string[]): string[] {
  if (context.role === 'DISPATCHER') {
    return allZoneIds.map(zoneRoom);
  }
  if (context.role === 'FLEET_MANAGER' && context.tenantId) {
    return [tenantRoom(context.tenantId)];
  }
  if (context.role === 'TECHNICIAN' && context.actorId) {
    return [technicianRoom(context.actorId)];
  }
  return [];
}

// Roles allowed to ask for a per-job room at all. Whether THIS caller may have
// THIS job is a database question — the same scoped read the HTTP routes use —
// and is answered in server.ts, not here.
const ROLES_THAT_SUBSCRIBE_TO_JOBS: ReadonlySet<Role> = new Set([
  'DRIVER',
  'TECHNICIAN',
  'DISPATCHER',
  'FLEET_MANAGER',
]);

export function mayRequestJobRoom(role: Role): boolean {
  return ROLES_THAT_SUBSCRIBE_TO_JOBS.has(role);
}

// Where one job event is published. The job's own room, plus the zone and
// tenant rooms it belongs to, so a dispatcher watching a geography and a fleet
// manager watching a fleet both see it without having subscribed to the job.
// THE EVENTS A TECHNICIAN MUST HEAR BEFORE THE JOB IS THEIRS.
//
// Deliberately a short, named list rather than "anything with a technicianId in
// it". A technician who is already on a job is in its job room and hears
// everything through that; the only gap this closes is the moment before that
// is true. Adding an event here means deciding that it must reach somebody who
// has no other connection to the job, which is a decision worth making one
// event at a time.
const EVENTS_A_TECHNICIAN_HEARS_OFF_JOB: ReadonlySet<string> = new Set([
  'TECHNICIAN_OFFER_SENT',
]);

export function technicianRoomForEvent(eventType: string, payload: unknown): string | null {
  if (!EVENTS_A_TECHNICIAN_HEARS_OFF_JOB.has(eventType)) return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const technicianId = (payload as { technicianId?: unknown }).technicianId;
  if (typeof technicianId !== 'string' || technicianId.length === 0) return null;
  return technicianRoom(technicianId);
}

export function roomsForJobEvent(job: {
  id: string;
  zoneId: string;
  tenantId: string | null;
}): string[] {
  const rooms = [jobRoom(job.id), zoneRoom(job.zoneId)];
  // A walk-in consumer job has no tenant, so there is no fleet to notify.
  if (job.tenantId) {
    rooms.push(tenantRoom(job.tenantId));
  }
  return rooms;
}
