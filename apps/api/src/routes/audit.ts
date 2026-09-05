// apps/api/src/routes/audit.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUDIT_EVENT_TYPES } from '@acsf/shared';
import type { AppContext } from '../appContext';
import { parseOrThrow } from '../schemas';

const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    eventType: z.enum(AUDIT_EVENT_TYPES).optional(),
  })
  .strict();

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/audit-events', async (request) => {
    const query = parseOrThrow(ListQuerySchema, request.query);
    const events = ctx.audit.list({
      limit: query.limit,
      offset: query.offset,
      eventType: query.eventType,
    });
    return { events, count: events.length };
  });

  app.get('/api/audit/verify', async () => ctx.audit.verifyChain());
}