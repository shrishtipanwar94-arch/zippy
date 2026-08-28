// A small set of vehicle profiles and drivers so Phase 3 intake has real
// vehicles to attach a job to. Not called out in the build plan's seed list,
// but cheap now and awkward to retrofit. Two fleet drivers per fleet tenant,
// two walk-in consumers. One profile is a Tata Nexon EV so the EV scarcity
// path has a vehicle that actually needs a high-voltage-certified technician.

import type { PrismaClient } from '@prisma/client';
import { DEV_PASSWORD_HASH } from './devPassword.js';

type ProfileSeed = {
  id: string;
  make: string;
  model: string;
  yearFrom: number;
  yearTo: number;
  bodyType: string;
  fuelType: string;
  evClass: string | null;
  keyType: string;
};

const PROFILES: ProfileSeed[] = [
  { id: 'vp-swift', make: 'MARUTI_SUZUKI', model: 'Swift', yearFrom: 2018, yearTo: 2024, bodyType: 'HATCHBACK', fuelType: 'PETROL', evClass: null, keyType: 'TRANSPONDER' },
  { id: 'vp-i20', make: 'HYUNDAI', model: 'i20', yearFrom: 2020, yearTo: 2024, bodyType: 'HATCHBACK', fuelType: 'PETROL', evClass: null, keyType: 'SMART' },
  { id: 'vp-nexon-ev', make: 'TATA', model: 'Nexon EV', yearFrom: 2021, yearTo: 2024, bodyType: 'SUV', fuelType: 'ELECTRIC', evClass: 'HV', keyType: 'SMART' },
  { id: 'vp-xuv500', make: 'MAHINDRA', model: 'XUV500', yearFrom: 2016, yearTo: 2021, bodyType: 'SUV', fuelType: 'DIESEL', evClass: null, keyType: 'TRANSPONDER' },
  { id: 'vp-innova', make: 'TOYOTA', model: 'Innova Crysta', yearFrom: 2017, yearTo: 2023, bodyType: 'MPV', fuelType: 'DIESEL', evClass: null, keyType: 'SMART' },
  { id: 'vp-tiago', make: 'TATA', model: 'Tiago', yearFrom: 2019, yearTo: 2024, bodyType: 'HATCHBACK', fuelType: 'PETROL', evClass: null, keyType: 'TRANSPONDER' },
];

type DriverSeed = {
  id: string;
  name: string;
  tenantId: string | null;
  profileId: string;
  registration: string;
  colour: string;
  homeZoneIndex: number;
};

const DRIVERS: DriverSeed[] = [
  { id: 'metrocab-1', name: 'MetroCab Driver 1', tenantId: 'tenant-metrocab', profileId: 'vp-innova', registration: 'KA01AB1001', colour: 'White', homeZoneIndex: 0 },
  { id: 'metrocab-2', name: 'MetroCab Driver 2', tenantId: 'tenant-metrocab', profileId: 'vp-nexon-ev', registration: 'KA01AB1002', colour: 'Blue', homeZoneIndex: 1 },
  { id: 'city-1', name: 'CityLogistics Driver 1', tenantId: 'tenant-citylogistics', profileId: 'vp-xuv500', registration: 'KA02CD2001', colour: 'Silver', homeZoneIndex: 2 },
  { id: 'quick-1', name: 'QuickMove Driver 1', tenantId: 'tenant-quickmove', profileId: 'vp-tiago', registration: 'KA03EF3001', colour: 'Red', homeZoneIndex: 3 },
  { id: 'walkin-1', name: 'Walk-in Driver 1', tenantId: 'tenant-walkin', profileId: 'vp-swift', registration: 'KA04GH4001', colour: 'Grey', homeZoneIndex: 4 },
  { id: 'walkin-2', name: 'Walk-in Driver 2', tenantId: 'tenant-walkin', profileId: 'vp-i20', registration: 'KA05IJ5001', colour: 'Black', homeZoneIndex: 5 },
];

const ZONE_CODES = ['kor', 'ind', 'whf', 'jay', 'heb', 'elc'];

export async function seedDrivers(prisma: PrismaClient): Promise<void> {
  for (const profile of PROFILES) {
    await prisma.vehicleProfile.upsert({
      where: { id: profile.id },
      update: { bodyType: profile.bodyType, fuelType: profile.fuelType, evClass: profile.evClass, keyType: profile.keyType },
      create: {
        id: profile.id,
        make: profile.make,
        model: profile.model,
        yearFrom: profile.yearFrom,
        yearTo: profile.yearTo,
        bodyType: profile.bodyType,
        fuelType: profile.fuelType,
        evClass: profile.evClass,
        keyType: profile.keyType,
      },
    });
  }

  for (const driver of DRIVERS) {
    const email = `driver-${driver.id}@zippy.internal`;
    const userId = `user-driver-${driver.id}`;
    const driverId = `driver-${driver.id}`;

    await prisma.user.upsert({
      where: { email },
      update: { name: driver.name, passwordHash: DEV_PASSWORD_HASH },
      create: { id: userId, email, passwordHash: DEV_PASSWORD_HASH, role: 'DRIVER', name: driver.name },
    });

    await prisma.driver.upsert({
      where: { id: driverId },
      update: { tenantId: driver.tenantId, homeZoneId: `zone-${ZONE_CODES[driver.homeZoneIndex]}` },
      create: {
        id: driverId,
        userId,
        tenantId: driver.tenantId,
        homeZoneId: `zone-${ZONE_CODES[driver.homeZoneIndex]}`,
      },
    });

    await prisma.vehicle.upsert({
      where: { registration: driver.registration },
      update: { colour: driver.colour, profileId: driver.profileId },
      create: {
        id: `vehicle-${driver.id}`,
        driverId,
        tenantId: driver.tenantId,
        profileId: driver.profileId,
        registration: driver.registration,
        colour: driver.colour,
      },
    });
  }
}
