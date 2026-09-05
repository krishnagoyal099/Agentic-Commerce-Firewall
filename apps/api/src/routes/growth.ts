// apps/api/src/routes/growth.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACTOR_IDS } from '@acsf/shared';
import type { AppContext } from '../appContext';
import { parseOrThrow } from '../schemas';
import { DomainError } from '../utils/errors';

const ProposeSchema = z
  .object({
    mandateId: z.string().min(1).max(64).optional(),
    cartId: z.string().min(1).max(64).optional(),
  })
  .strict();

export function registerGrowthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/growth/analytics', async () => ({
    analytics: ctx.growth.analytics(),
    source: 'computed from completed orders (real transaction history)',
  }));

  app.get('/api/growth/opportunities', async () => ({
    opportunities: ctx.growth.listOpportunities(),
  }));

  app.post('/api/growth/proposals', async (request) => {
    const body = parseOrThrow(ProposeSchema, request.body ?? {});
    const mandateId =
      body.mandateId ??
      ctx.mandates.getActiveMandateForUser(ACTOR_IDS.demoUserId)?.row.id ??
      null;
    if (mandateId === null) {
      throw new DomainError(
        'MANDATE_NOT_FOUND',
        'No active mandate for the demo user; issue a mandate first.',
      );
    }
    return ctx.growth.propose({ mandateId, cartId: body.cartId ?? null });
  });
}