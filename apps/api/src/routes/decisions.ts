// apps/api/src/routes/decisions.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DECISIONS, renderReceipt } from '@acsf/shared';
import type { AppContext } from '../appContext';
import { parseOrThrow } from '../schemas';
import { toDecisionSummary } from '../utils/dto';
import { DomainError } from '../utils/errors';

const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    decision: z.enum(DECISIONS).optional(),
    sessionId: z.string().min(1).max(64).optional(),
  })
  .strict();

const ApproveSchema = z
  .object({
    approvedBy: z.string().min(1).max(64),
    outcome: z.enum(['approved', 'rejected']),
    note: z.string().max(500).optional(),
  })
  .strict();

export function registerDecisionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/decisions', async (request) => {
    const query = parseOrThrow(ListQuerySchema, request.query);
    const rows =
      query.sessionId !== undefined
        ? ctx.authorization.listDecisionsBySession(query.sessionId)
        : ctx.authorization.listDecisions({
            limit: query.limit,
            offset: query.offset,
            decision: query.decision,
          });
    return { decisions: rows.map(toDecisionSummary) };
  });

  app.get('/api/decisions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = ctx.authorization.getDecision(id);
    if (row === null) throw new DomainError('DECISION_NOT_FOUND', `Decision ${id} does not exist.`);
    return { decision: row, rendered: renderReceipt(row.receipt) };
  });

  app.get('/api/decisions/:id/receipt', async (request) => {
    const { id } = request.params as { id: string };
    const receipt = ctx.authorization.getDecisionReceipt(id);
    if (receipt === null) throw new DomainError('DECISION_NOT_FOUND', `Decision ${id} does not exist.`);
    return { receipt, rendered: renderReceipt(receipt) };
  });

  // Human approval (§60): only non-agents may approve; the engine enforces.
  app.post('/api/decisions/:id/approve', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(ApproveSchema, request.body);
    const { decision, approval } = ctx.authorization.recordHumanApproval(id, body.approvedBy, body.outcome, body.note);
    return {
      decision: { id: decision.id, decision: decision.decision, approvedAt: decision.approvedAt, consumedAt: decision.consumedAt },
      approval,
    };
  });
}
