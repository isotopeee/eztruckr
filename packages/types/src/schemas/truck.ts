import { z } from 'zod';
import {
  auditFieldsSchema,
  isoDateTimeSchema,
  naturalCodeSchema,
  optionalText,
  quantityStringSchema,
} from './common';

/**
 * A truck as returned by the API.
 *
 * `capacityKg` is a physical quantity, not money, but still crosses the wire
 * as a string: it is a Postgres DECIMAL, and rounding it through a JSON number
 * on the way out would be the same mistake for a different reason.
 */
export const truckSchema = auditFieldsSchema.extend({
  id: z.string(),
  plateNumber: z.string(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  modelYear: z.number().int().nullable(),
  bodyType: z.string().nullable(),
  capacityKg: z.string().nullable(),
  registrationExpiry: z.string().nullable(),
  isActive: z.boolean(),
});

export type Truck = z.infer<typeof truckSchema>;

const currentYear = new Date().getUTCFullYear();

export const createTruckSchema = z.object({
  plateNumber: naturalCodeSchema,
  make: optionalText(80),
  model: optionalText(80),
  // Upper bound allows next year's models, which are on sale before the year
  // turns; the lower bound is simply older than any truck still hauling.
  modelYear: z
    .number()
    .int()
    .min(1950)
    .max(currentYear + 1)
    .nullish()
    .transform((value) => value ?? null),
  bodyType: optionalText(80),
  capacityKg: quantityStringSchema.nullish().transform((value) => value ?? null),
  registrationExpiry: isoDateTimeSchema.nullish().transform((value) => value ?? null),
  isActive: z.boolean().default(true),
});

export type CreateTruckInput = z.infer<typeof createTruckSchema>;

export const updateTruckSchema = createTruckSchema.partial();

export type UpdateTruckInput = z.infer<typeof updateTruckSchema>;
