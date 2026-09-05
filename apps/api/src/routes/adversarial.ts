// apps/api/src/routes/adversarial.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACTOR_IDS } from '@acsf/shared';
import type { AppContext } from '../appContext';
import { parseOrThrow } from '../schemas';
import { DomainError } from '../utils/errors';

const RunSchema = z
  .object({ mandateId: z.string().min(1).max(64).optional() })
  .strict();

export function registerAdversarialRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/adversarial/run', async (request) => {
    const body = parseOrThrow(RunSchema, request.body ?? {});
    const mandateId =
      body.mandateId ??
      ctx.mandates.getActiveMandateForUser(ACTOR_IDS.demoUserId)?.row.id ??
      null;
    if (mandateId === null) {
      throw new DomainError('MANDATE_NOT_FOUND', 'No active mandate for the demo user.');
    }
    return ctx.adversarial.run(mandateId);
  });
}
