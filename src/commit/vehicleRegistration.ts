// REGISTERING A VEHICLE TO A TENANT — and the one thing that must never happen.
//
// A VEHICLE BELONGS TO EXACTLY ONE TENANT. It sounds like paperwork and it is
// not: the tenant on the vehicle is what decides whose contract a breakdown is
// served under, whose SLA window the solver prices, and who gets the invoice.
// A registration plate sitting under two tenants makes all three questions have
// two answers, and the system would pick whichever row a query happened to
// return first — silently serving one fleet's vehicle on another fleet's
// contract. There is no later check that catches that, because by then the job
// looks entirely ordinary.
//
// So it is rejected AT REGISTRATION, which is the only moment the conflict is
// visible as a conflict rather than as a strange invoice six weeks later.
//
// TWO WAYS A VEHICLE ENDS UP WITH TWO TENANTS, and both are checked:
//   1. the plate is already registered, to a different tenant. The unique index
//      on `vehicles.registration` would raise this as a constraint violation
//      anyway; catching it here is what turns "unique constraint failed" into a
//      sentence naming the tenant that already holds it.
//   2. the vehicle's tenant differs from its DRIVER'S tenant. The row would
//      insert cleanly and the vehicle would belong to one tenant by its own
//      column and to another through the person who drives it. This is the
//      subtle one and it has no database constraint behind it at all.

import type { PrismaClient } from '@prisma/client';

export type RegisterVehicleInput = {
  driverId: string;
  tenantId: string | null;
  profileId: string;
  registration: string;
  colour: string;
};

export type RegisterVehicleResult =
  | { outcome: 'REGISTERED'; vehicleId: string }
  | { outcome: 'REJECTED'; code: RegistrationRejection; detail: string };

export type RegistrationRejection =
  | 'DRIVER_NOT_FOUND'
  // The plate is on file under a different tenant. The conflict this whole
  // file exists for.
  | 'REGISTERED_TO_ANOTHER_TENANT'
  // The plate is on file under the SAME tenant. Not a tenancy conflict, just a
  // duplicate — a different message, because the fix is different.
  | 'REGISTRATION_ALREADY_EXISTS'
  // The vehicle and its driver would belong to different tenants.
  | 'DRIVER_TENANT_MISMATCH';

// Plates are compared with case and spacing normalised, because "MH04 7712"
// and "mh-04-7712" are the same vehicle to everyone except a string equality
// check — and a check that can be defeated by a space is not a check.
export function normaliseRegistration(registration: string): string {
  return registration.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function registerVehicle(
  db: PrismaClient,
  input: RegisterVehicleInput,
): Promise<RegisterVehicleResult> {
  const registration = normaliseRegistration(input.registration);

  const driver = await db.driver.findUnique({
    where: { id: input.driverId },
    select: { id: true, tenantId: true },
  });
  if (!driver) {
    return { outcome: 'REJECTED', code: 'DRIVER_NOT_FOUND', detail: `no driver ${input.driverId}` };
  }

  if (driver.tenantId !== input.tenantId) {
    return {
      outcome: 'REJECTED',
      code: 'DRIVER_TENANT_MISMATCH',
      detail:
        `driver ${driver.id} belongs to tenant ${driver.tenantId ?? 'none'}, ` +
        `so the vehicle cannot be registered to ${input.tenantId ?? 'none'}`,
    };
  }

  const existing = await db.vehicle.findUnique({
    where: { registration },
    select: { id: true, tenantId: true },
  });
  if (existing) {
    const sameTenant = existing.tenantId === input.tenantId;
    return {
      outcome: 'REJECTED',
      code: sameTenant ? 'REGISTRATION_ALREADY_EXISTS' : 'REGISTERED_TO_ANOTHER_TENANT',
      detail: sameTenant
        ? `${registration} is already registered to this tenant`
        : `${registration} is already registered to tenant ${existing.tenantId ?? 'none'}`,
    };
  }

  // TWO CALLERS CAN REACH HERE AT THE SAME MOMENT with the same plate — the
  // read above and this insert are not one atomic step. The unique index is
  // what actually enforces it; the check above exists to produce a readable
  // reason in the ordinary case, not to be the guard. The loser of the race
  // gets a constraint violation, which the error middleware already turns into
  // a 409.
  const vehicle = await db.vehicle.create({
    data: {
      driverId: driver.id,
      tenantId: input.tenantId,
      profileId: input.profileId,
      registration,
      colour: input.colour,
    },
    select: { id: true },
  });

  return { outcome: 'REGISTERED', vehicleId: vehicle.id };
}
