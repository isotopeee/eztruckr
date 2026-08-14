import { z } from 'zod';
import { auditFieldsSchema, moneyStringSchema, quantityStringSchema, requiredText } from './common';

export const routeSchema = auditFieldsSchema.extend({
  id: z.string(),
  name: z.string(),
  origin: z.string(),
  destination: z.string(),
  distanceKm: z.string().nullable(),
  standardRate: z.string().nullable(),
  standardAllowance: z.string().nullable(),
  isActive: z.boolean(),
});

export type Route = z.infer<typeof routeSchema>;

export const createRouteSchema = z.object({
  name: requiredText(200),
  origin: requiredText(200),
  destination: requiredText(200),
  distanceKm: quantityStringSchema.nullish().transform((value) => value ?? null),
  /** Indicative freight rate used to prefill a shipment. Money. */
  standardRate: moneyStringSchema.nullish().transform((value) => value ?? null),
  /**
   * What the crew are normally advanced for this run. Money.
   *
   * A default that prefills the first allowance and is editable there. Nothing
   * downstream reads it: the variance is measured against what was actually
   * released, never against what was expected to be.
   */
  standardAllowance: moneyStringSchema.nullish().transform((value) => value ?? null),
  isActive: z.boolean().default(true),
});

export type CreateRouteInput = z.infer<typeof createRouteSchema>;

export const updateRouteSchema = createRouteSchema.partial();

export type UpdateRouteInput = z.infer<typeof updateRouteSchema>;
