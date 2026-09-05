// apps/api/src/routes/intent.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATEGORIES, CATEGORY_LABELS, INTENT_PRESETS, MANDATE_BOUNDS } from '@acsf/shared';
import type { AppContext } from '../appContext';
import { DomainError } from '../utils/errors';

const IntentPlanSchema = z
  .object({
    intent: z.string().trim().min(5).max(500),
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

/**
 * Intent → proposed mandate, previewed BEFORE any authority exists. This is a
 * drafting endpoint: it creates no mandate, touches no money, and its output
 * still has to survive MandateService validation when the demo runs.
 */
export function registerIntentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/intent/options', async () => ({
    categories: CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] })),
    presets: INTENT_PRESETS,
    bounds: MANDATE_BOUNDS,
    llm: {
      enabled: ctx.config.llmEnabled,
      model: ctx.config.llmEnabled ? ctx.config.llmModel : null,
      warning: ctx.config.llmWarning,
    },
  }));

  app.post('/api/intent/plan', async (request) => {
    const parsed = IntentPlanSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        'INVALID_INTENT',
        `Intent failed validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    const { intent, ...overrides } = parsed.data;
    return ctx.intentService.plan(intent, overrides);
  });
}
