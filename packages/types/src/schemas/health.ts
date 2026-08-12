import { z } from 'zod';

export const healthStatusSchema = z.enum(['ok', 'degraded']);

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  uptimeSeconds: z.number(),
  /** UTC instant; the web app renders it in Asia/Manila. */
  timestamp: z.string().datetime(),
  checks: z.object({
    database: z.enum(['up', 'down']),
    storage: z.enum(['up', 'down', 'skipped']),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
