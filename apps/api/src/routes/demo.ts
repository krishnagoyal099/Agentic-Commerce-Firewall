// apps/api/src/routes/demo.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATEGORIES, MANDATE_BOUNDS } from '@acsf/shared';
import type { AppContext } from '../appContext';
import type { DemoRunOptions } from '../services/DemoService';
import { DomainError } from '../utils/errors';

/**
 * The demo run is parameterised by the USER's intent. Every field is optional:
 * an empty body reproduces the original scripted demo exactly.
 */
const DemoRunSchema = z
  .object({
    intent: z.string().trim().min(5).max(500).optional(),
    maxAmountRupees: z
      .number()
      .int()
      .min(MANDATE_BOUNDS.minAmountRupees)
      .max(MANDATE_BOUNDS.maxAmountRupees)
      .optional(),
    allowedCategories: z.array(z.enum(CATEGORIES)).min(1).max(CATEGORIES.length).optional(),
    allowUpsell: z.boolean().optional(),
    ttlHours: z.number().int().min(MANDATE_BOUNDS.minTtlHours).max(MANDATE_BOUNDS.maxTtlHours).optional(),
  })
  .strict();

function parseRunOptions(body: unknown): DemoRunOptions {
  const parsed = DemoRunSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new DomainError(
      'INVALID_DEMO_OPTIONS',
      `Demo options failed validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

export function registerDemoRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/demo/reset', async (request) => ctx.demo.reset(parseRunOptions(request.body)));
  app.post('/api/demo/start', async (request) => ctx.demo.start(parseRunOptions(request.body)));
}
