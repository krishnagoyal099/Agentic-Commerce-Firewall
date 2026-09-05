// apps/api/src/routes/proposals.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../appContext';
import { ActionPayloadSchema, parseOrThrow } from '../schemas';
import { DomainError } from '../utils/errors';

const EvaluateProposalSchema = z
  .object({
    agentId: z.string().min(1).max(64),
    mandateId: z.string().min(1).max(64).nullish(),
    requestedCapabilities: z.array(z.string().min(1).max(64)).max(20).optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
    action: ActionPayloadSchema,
  })
  .strict();

const AuthorizationCheckSchema = z
  .object({ decisionId: z.string().min(1).max(64) })
  .strict();

export function registerProposalRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Generic evaluation-only endpoint: real firewall, no state mutation.
  app.post('/api/proposals/evaluate', async (request) => {
    const body = parseOrThrow(EvaluateProposalSchema, request.body);
    return ctx.gateway.submitPayload(
      body.action,
      {
        agentId: body.agentId,
        mandateId: body.mandateId ?? null,
        protocol: 'REST',
        requestedCapabilities: body.requestedCapabilities,
        idempotencyKey: body.idempotencyKey,
      },
      { execute: false },
    );
  });

  app.post('/api/authorization/check', async (request) => {
    const body = parseOrThrow(AuthorizationCheckSchema, request.body);
    const row = ctx.authorization.getDecision(body.decisionId);
    if (row === null) throw new DomainError('DECISION_NOT_FOUND', `Decision ${body.decisionId} does not exist.`);
    const authorized = row.decision === 'ALLOW' || (row.decision === 'HUMAN_APPROVAL' && row.approvedAt !== null);
    return {
      decisionId: row.id,
      decision: row.decision,
      actionType: row.actionType,
      reason: row.reason,
      approved: row.approvedAt !== null,
      consumed: row.consumedAt !== null,
      authorizesExecution: authorized && row.consumedAt === null,
    };
  });
}