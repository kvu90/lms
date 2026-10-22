import { z } from 'zod';

export const healthStatusSchema = z.object({
  status: z.enum(['ok', 'error']),
  timestamp: z.string().min(1),
  checks: z.object({
    database: z.enum(['up', 'down']),
    redis: z.enum(['up', 'down']),
  }),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
