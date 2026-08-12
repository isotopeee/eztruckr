import { z } from 'zod';
import {
  auditFieldsSchema,
  moneyStringSchema,
  naturalCodeSchema,
  quantityStringSchema,
  requiredText,
} from './common';

export const routeSchema = auditFieldsSchema.extend({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  origin: z.string(),
  destination: z.string(),
  distanceKm: z.string().nullable(),
  standardRate: z.string().nullable(),
  isActive: z.boolean(),
});

export type Route = z.infer<typeof routeSchema>;

export const createRouteSchema = z.object({
  code: naturalCodeSchema,
  name: requiredText(200),
  origin: requiredText(200),
  destination: requiredText(200),
  distanceKm: quantityStringSchema.nullish().transform((value) => value ?? null),
  /** Indicative freight rate used to prefill a shipment. Money. */
  standardRate: moneyStringSchema.nullish().transform((value) => value ?? null),
  isActive: z.boolean().default(true),
});

export type CreateRouteInput = z.infer<typeof createRouteSchema>;

export const updateRouteSchema = createRouteSchema.partial();

export type UpdateRouteInput = z.infer<typeof updateRouteSchema>;
