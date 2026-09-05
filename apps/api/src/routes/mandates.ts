// apps/api/src/routes/mandates.ts  (MODIFIED — full reprint; static schema import replaces dynamic-import block)
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../appContext';
import * as schema from '../db/schema';
import { MandateCreateSchema } from '../services/MandateService';
import { parseOrThrow } from '../schemas';
import { toMandateDTO } from '../utils/dto';
import { DomainError } from '../utils/errors';

export function registerMandateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/mandates', async (request) => {
    const body = parseOrThrow(MandateCreateSchema, request.body);
    const view = ctx.mandates.createMandate(body, body.userId);
    return { mandate: toMandateDTO(view.row, view.effectiveStatus) };
  });

  app.get('/api/mandates', async () => {
    const nowIso = ctx.clock.now().toISOString();
    const rows = ctx.db.select().from(schema.mandates).all();
    return {
      mandates: rows
        .sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1))
        .map((row) => toMandateDTO(row, ctx.mandates.effectiveStatus(row, nowIso))),
    };
  });

  app.get('/api/mandates/:id', async (request) => {
    const { id } = request.params as { id: string };
    const view = ctx.mandates.getMandate(id);
    if (view === null) throw new DomainError('MANDATE_NOT_FOUND', `Mandate ${id} does not exist.`);
    return { mandate: toMandateDTO(view.row, view.effectiveStatus) };
  });
}