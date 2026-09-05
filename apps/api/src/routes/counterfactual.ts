// apps/api/src/routes/counterfactual.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../appContext';
import { parseOrThrow } from '../schemas';

const CounterfactualSchema = z
  .object({
    parameter: z.enum(['discountPaise', 'amountPaise', 'mandateMaxPaise']),
    values: z.array(z.number().int().min(0).max(100_000_000)).min(1).max(12),
  })
  .strict();

export function registerCounterfactualRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/counterfactual', async (request) => {
    const body = parseOrThrow(CounterfactualSchema, request.body);
    return ctx.counterfactual.evaluate(body);
  });
}