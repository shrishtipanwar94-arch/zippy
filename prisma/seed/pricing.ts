// One active price list, "Standard 2026", plus every rate a job needs to be
// priced: a per-part price, an hourly labour rate, a per-km tow tariff and a
// callout fee. Prices are versioned with validFrom / validTo — a job prices
// against the list in force at creation and is never re-priced. Only this one
// list exists for now; the versioning columns are what make that guarantee
// expressible later.

import type { PrismaClient } from '@prisma/client';
import { START_OF_YEAR } from './client.js';
import { PARTS, partId } from './parts.js';

export const PRICE_LIST_ID = 'pricelist-standard-2026';

export async function seedPricing(prisma: PrismaClient): Promise<void> {
  await prisma.priceList.upsert({
    where: { id: PRICE_LIST_ID },
    update: { active: true, validTo: null },
    create: {
      id: PRICE_LIST_ID,
      name: 'Standard 2026',
      currency: 'INR',
      validFrom: START_OF_YEAR,
      active: true,
    },
  });

  for (const part of PARTS) {
    const id = `partprice-${part.sku.toLowerCase()}`;
    await prisma.partPrice.upsert({
      where: { id },
      update: { unitPricePaise: part.pricePaise },
      create: {
        id,
        priceListId: PRICE_LIST_ID,
        partId: partId(part.sku),
        unitPricePaise: part.pricePaise,
        validFrom: START_OF_YEAR,
      },
    });
  }

  const labourRates: { code: string; ratePerHourPaise: number }[] = [
    { code: 'STANDARD', ratePerHourPaise: 60000 },
    { code: 'SPECIALIST', ratePerHourPaise: 120000 },
  ];
  for (const rate of labourRates) {
    const id = `labour-${rate.code.toLowerCase()}`;
    await prisma.labourRate.upsert({
      where: { id },
      update: { ratePerHourPaise: rate.ratePerHourPaise },
      create: {
        id,
        priceListId: PRICE_LIST_ID,
        code: rate.code,
        ratePerHourPaise: rate.ratePerHourPaise,
        validFrom: START_OF_YEAR,
      },
    });
  }

  const towTariffs: { towType: string; perKmPaise: number; minChargePaise: number }[] = [
    { towType: 'FLATBED', perKmPaise: 4000, minChargePaise: 50000 },
    { towType: 'WHEEL_LIFT', perKmPaise: 3500, minChargePaise: 40000 },
  ];
  for (const tariff of towTariffs) {
    const id = `tow-${tariff.towType.toLowerCase()}`;
    await prisma.towTariff.upsert({
      where: { id },
      update: { perKmPaise: tariff.perKmPaise, minChargePaise: tariff.minChargePaise },
      create: {
        id,
        priceListId: PRICE_LIST_ID,
        towType: tariff.towType,
        perKmPaise: tariff.perKmPaise,
        minChargePaise: tariff.minChargePaise,
        validFrom: START_OF_YEAR,
      },
    });
  }

  const calloutFees: { serviceType: string; feePaise: number }[] = [
    { serviceType: 'STANDARD', feePaise: 30000 },
    { serviceType: 'HIGHWAY', feePaise: 50000 },
  ];
  for (const fee of calloutFees) {
    const id = `callout-${fee.serviceType.toLowerCase()}`;
    await prisma.calloutFee.upsert({
      where: { id },
      update: { feePaise: fee.feePaise },
      create: {
        id,
        priceListId: PRICE_LIST_ID,
        serviceType: fee.serviceType,
        feePaise: fee.feePaise,
        validFrom: START_OF_YEAR,
      },
    });
  }
}
