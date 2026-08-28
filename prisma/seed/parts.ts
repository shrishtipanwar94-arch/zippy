// Around twenty parts in a handful of categories. Stock levels per unit live in
// fleet.ts; prices live in pricing.ts. Nothing reads inventory until Phase 18,
// but the rows must exist now so those phases arrive as a migration that only
// adds behaviour, not tables.

import type { PrismaClient } from '@prisma/client';

export const PART_CATEGORIES: { code: string; name: string }[] = [
  { code: 'BATTERY', name: 'Batteries' },
  { code: 'TYRE', name: 'Tyres and wheels' },
  { code: 'BRAKES', name: 'Brakes' },
  { code: 'ELECTRICAL', name: 'Electrical' },
  { code: 'FLUIDS', name: 'Fluids' },
  { code: 'FUEL', name: 'Fuel' },
  { code: 'CONSUMABLES', name: 'Consumables' },
  { code: 'RECOVERY', name: 'Recovery equipment' },
];

type PartSeed = {
  sku: string;
  name: string;
  category: string;
  pricePaise: number;
};

// pricePaise is the Standard price list entry created in pricing.ts. Integer
// paise everywhere — never a float.
export const PARTS: PartSeed[] = [
  { sku: 'BAT-45AH', name: 'Car battery 45Ah', category: 'BATTERY', pricePaise: 480000 },
  { sku: 'BAT-65AH', name: 'Car battery 65Ah', category: 'BATTERY', pricePaise: 720000 },
  { sku: 'TYRE-15', name: 'Tyre 195/65 R15', category: 'TYRE', pricePaise: 550000 },
  { sku: 'TYRE-16', name: 'Tyre 205/55 R16', category: 'TYRE', pricePaise: 680000 },
  { sku: 'TYRE-REPAIR-KIT', name: 'Tyre puncture repair kit', category: 'TYRE', pricePaise: 45000 },
  { sku: 'BRK-PAD-FRONT', name: 'Front brake pad set', category: 'BRAKES', pricePaise: 250000 },
  { sku: 'BRK-PAD-REAR', name: 'Rear brake pad set', category: 'BRAKES', pricePaise: 220000 },
  { sku: 'BRK-FLUID-DOT4', name: 'Brake fluid DOT4 500ml', category: 'BRAKES', pricePaise: 35000 },
  { sku: 'ALT-RECON', name: 'Reconditioned alternator', category: 'ELECTRICAL', pricePaise: 650000 },
  { sku: 'STR-MOTOR-RECON', name: 'Reconditioned starter motor', category: 'ELECTRICAL', pricePaise: 580000 },
  { sku: 'FUSE-ASSORTED', name: 'Assorted fuse pack', category: 'ELECTRICAL', pricePaise: 15000 },
  { sku: 'BULB-H4', name: 'Headlight bulb H4', category: 'ELECTRICAL', pricePaise: 40000 },
  { sku: 'KEY-FOB-BLANK', name: 'Transponder key fob blank', category: 'ELECTRICAL', pricePaise: 120000 },
  { sku: 'OIL-5W30-4L', name: 'Engine oil 5W-30 4L', category: 'FLUIDS', pricePaise: 320000 },
  { sku: 'COOLANT-5L', name: 'Coolant premix 5L', category: 'FLUIDS', pricePaise: 45000 },
  { sku: 'PETROL-5L', name: 'Petrol canister 5L', category: 'FUEL', pricePaise: 55000 },
  { sku: 'DIESEL-5L', name: 'Diesel canister 5L', category: 'FUEL', pricePaise: 55000 },
  { sku: 'WIPER-PAIR', name: 'Wiper blade pair', category: 'CONSUMABLES', pricePaise: 60000 },
  { sku: 'SPARK-PLUG-SET', name: 'Spark plug set', category: 'CONSUMABLES', pricePaise: 90000 },
  { sku: 'DRIVE-BELT', name: 'Auxiliary drive belt', category: 'CONSUMABLES', pricePaise: 140000 },
  { sku: 'TOW-STRAP-5T', name: 'Tow strap 5 tonne', category: 'RECOVERY', pricePaise: 350000 },
  { sku: 'JUMP-LEAD-HEAVY', name: 'Heavy-duty jump leads', category: 'RECOVERY', pricePaise: 180000 },
];

export function partCategoryId(code: string): string {
  return `partcat-${code.toLowerCase()}`;
}

export function partId(sku: string): string {
  return `part-${sku.toLowerCase()}`;
}

export async function seedParts(prisma: PrismaClient): Promise<void> {
  for (const category of PART_CATEGORIES) {
    await prisma.partCategory.upsert({
      where: { code: category.code },
      update: { name: category.name },
      create: { id: partCategoryId(category.code), code: category.code, name: category.name },
    });
  }

  for (const part of PARTS) {
    await prisma.part.upsert({
      where: { sku: part.sku },
      update: { name: part.name, categoryId: partCategoryId(part.category) },
      create: {
        id: partId(part.sku),
        sku: part.sku,
        name: part.name,
        categoryId: partCategoryId(part.category),
      },
    });
  }
}
