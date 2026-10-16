// THE DEMO BOARD'S ONE WORKSHOP — where a tow goes.
//
// Only one fault the driver screen can report needs a tow (IMMOBILISED_UNKNOWN),
// and a tow is only feasible with somewhere to take the car: destination
// selection (src/engine/destinationSelection.ts) screens workshops by brand
// authorisation, opening hours and EV class. Open 00:00-24:00 every day so an
// evening demo is never refused for hours, and authorised for the demo car's
// brand. Upserted on its natural keys like everything else on the board.

import type { PrismaClient } from '@prisma/client';
import { DEMO_WORKSHOP, DEMO_ZONE } from '../../src/demo/demoCrews.js';

export async function seedDemoWorkshop(db: PrismaClient): Promise<void> {
  const workshop = await db.workshop.upsert({
    where: { code: DEMO_WORKSHOP.code },
    update: { name: DEMO_WORKSHOP.name, lat: DEMO_WORKSHOP.lat, lng: DEMO_WORKSHOP.lng, active: true },
    create: {
      id: DEMO_WORKSHOP.id,
      code: DEMO_WORKSHOP.code,
      name: DEMO_WORKSHOP.name,
      zoneId: DEMO_ZONE.id,
      lat: DEMO_WORKSHOP.lat,
      lng: DEMO_WORKSHOP.lng,
      evClass: null,
      active: true,
    },
    select: { id: true },
  });

  for (const brand of DEMO_WORKSHOP.brands) {
    await db.workshopAuthorisation.upsert({
      where: { workshopId_brand: { workshopId: workshop.id, brand } },
      update: { level: 'STANDARD' },
      create: { workshopId: workshop.id, brand, level: 'STANDARD' },
    });
  }

  for (let day = 0; day < 7; day++) {
    const allDay = { opens: '00:00', closes: '24:00', closed: false };
    await db.workshopHours.upsert({
      where: { workshopId_dayOfWeek: { workshopId: workshop.id, dayOfWeek: day } },
      update: allDay,
      create: { workshopId: workshop.id, dayOfWeek: day, ...allDay },
    });
  }
}
