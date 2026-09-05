// apps/api/src/routes/payments.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PAYMENT_STATES, type PaymentDTO } from '@acsf/shared';
import type { AppContext } from '../appContext';
import { parseOrThrow } from '../schemas';
import { DomainError } from '../utils/errors';

const ByDecisionSchema = z.object({ decisionId: z.string().min(1).max(64) }).strict();

const FreshSchema = z
  .object({
    agentId: z.string().min(1).max(64),
    mandateId: z.string().min(1).max(64),
    cartId: z.string().min(1).max(64),
    discountPaise: z.number().int().min(0).optional(),
    amountPaise: z.number().int().min(0).optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

const CreatePaymentSchema = z.union([ByDecisionSchema, FreshSchema]);

const PaymentIdParamSchema = z.object({ id: z.string().min(1).max(64) }).strict();

const ProviderEventSchema = z
  .object({
    event: z.string().min(1).max(100),
    state: z.enum(PAYMENT_STATES).nullish(),
    detail: z.string().max(300).optional(),
  })
  .strict();

function paymentOf(data: unknown): PaymentDTO | null {
  if (typeof data === 'object' && data !== null && 'state' in data && 'id' in data) {
    return data as PaymentDTO;
  }
  return null;
}

export function registerPaymentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/payments', async (request) => {
    const body = parseOrThrow(CreatePaymentSchema, request.body);
    if ('decisionId' in body) {
      // Execute a prior (possibly human-approved) decision — executePayment
      // re-verifies the entire §59 invariant chain.
      const payment = await ctx.payments.executePayment(body.decisionId);
      return { decisionId: body.decisionId, payment };
    }
    const cart = ctx.carts.getCart(body.cartId);
    if (cart === null) throw new DomainError('CART_NOT_FOUND', `Cart ${body.cartId} does not exist.`);
    const discountPaise = body.discountPaise ?? 0;
    // cart.totalPaise already has the cart's own stored discount taken off; the
    // request's discountPaise is additional. Defaulting from subtotalPaise
    // ignored the stored discount and overcharged by exactly that amount.
    const amountPaise = body.amountPaise ?? cart.totalPaise - discountPaise;
    const result = await ctx.gateway.submitPayload(
      { type: 'payment.create', cartId: body.cartId, amountPaise, discountPaise },
      { agentId: body.agentId, mandateId: body.mandateId, protocol: 'REST', idempotencyKey: body.idempotencyKey },
      { execute: true },
    );
    return { ...result, payment: paymentOf(result.data) };
  });

  app.get('/api/payments', async () => ({ payments: ctx.payments.listPayments(100) }));

  app.get('/api/payments/:id', async (request) => {
    const { id } = request.params as { id: string };
    const payment = ctx.payments.getPayment(id);
    if (payment === null) throw new DomainError('PAYMENT_NOT_FOUND', `Payment ${id} does not exist.`);
    return { payment };
  });

  /**
   * OPERATOR action, not an agent action. reconcile() is not read-only — it
   * transitions payment state, can perform a real provider capture, and
   * completes or fails the order — so it must never be exposed to an agent
   * surface. The equivalent through the gateway (payment.reconcile) requires
   * the payment.create capability and produces a persisted decision; this route
   * is the human/operator path and is deliberately kept out of MCP.
   */
  app.post('/api/payments/:id/reconcile', async (request) => {
    const { id } = parseOrThrow(PaymentIdParamSchema, request.params);
    return ctx.reconciliation.reconcile(id);
  });

  /**
   * Provider-event ingestion — a SIMULATOR for the demo, not a real webhook
   * endpoint: it has no signature verification, so anyone who can reach it
   * could drive a payment to CAPTURED and complete the order with no money
   * moved. It is therefore refused outside development/test. A production
   * deployment must replace this with a signature-verified provider webhook.
   */
  app.post('/api/payments/:id/events', async (request) => {
    if (ctx.config.nodeEnv === 'production') {
      throw new DomainError(
        'PROVIDER_EVENT_SIMULATION_DISABLED',
        'The provider-event simulator is disabled outside development; real deployments must use a signature-verified provider webhook.',
      );
    }
    const { id } = parseOrThrow(PaymentIdParamSchema, request.params);
    const body = parseOrThrow(ProviderEventSchema, request.body);
    return ctx.payments.handleProviderEvent(id, body.event, body.state ?? null, body.detail);
  });
}