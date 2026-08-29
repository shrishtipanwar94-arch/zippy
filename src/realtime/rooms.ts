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

// Rooms a connection joins the moment it authenticates, with no request from
// the client. These are the standing subscriptions a role has by virtue of
// being that role.
//
// A DRIVER or TECHNICIAN gets none: their interest is per-job, they can only be
// in rooms for jobs that are theirs, and which jobs those are changes over the
// life of the connection. They subscribe explicitly, one job at a time, and
// each subscription is authorised against the database.
export function standingRoomsFor(context: AuthContext, allZoneIds: string[]): string[] {
  if (context.role === 'DISPATCHER') {
    return allZoneIds.map(zoneRoom);
  }
  if (context.role === 'FLEET_MANAGER' && context.tenantId) {
    return [tenantRoom(context.tenantId)];
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
