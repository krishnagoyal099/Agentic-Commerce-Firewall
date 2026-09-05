// tests/invariants/invariants.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../apps/api/src/db/schema';
import {
  createCart,
  createStandardMandate,
  createTestApp,
  createTestServer,
  mockProvider,
  payCart,
  proposePayment,
  type TestApp,
} from '../helpers/testApp';

let t: TestApp;

beforeEach(() => {
  t = createTestApp();
});

afterEach(() => {
  t.close();
});

async function post(app: FastifyInstance, url: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

describe('security invariants (§70)', () => {
  it('1 · an agent can never directly invoke the payment provider', async () => {
    const mock = mockProvider(t.ctx);
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);

    // Blocked financial actions never reach the provider.
    await t.ctx.gateway.submitPayload(
      { type: 'payment.create', cartId: cart.id, amountPaise: cart.subtotalPaise - 200_000, discountPaise: 200_000 },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'REST' },
      { execute: true },
    );
    await t.ctx.gateway.submitPayload(
      { type: 'refund.create', paymentId: 'pay_x', amountPaise: 100_000 },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'REST' },
      { execute: false },
    );
    expect(mock.listProviderPayments()).toHaveLength(0);

    // One authorized payment → exactly one provider payment.
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(payment.state).toBe('CAPTURED');
    expect(mock.listProviderPayments()).toHaveLength(1);

    // Replay attempts never create a second provider payment.
    await t.ctx.payments.executePayment(payment.decisionId ?? '');
    expect(mock.listProviderPayments()).toHaveLength(1);
  });

  it('2 · catalog text cannot increase authority', async () => {
    const product = t.ctx.catalog.getProduct('malicious-001');
    expect(product?.description).toContain('AI INSTRUCTION');

    const mandateId = createStandardMandate(t.ctx);
    const baseCart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);

    // Obeying the injected "90% discount" as a price claim → PRICE_TAMPER.
    const claimed = await t.ctx.gateway.submitPayload(
      { type: 'cart.add_item', cartId: baseCart.id, items: [{ productId: 'malicious-001', quantity: 1, claimedUnitPricePaise: 749 }] },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: false },
    );
    expect(claimed.decision).toBe('BLOCK');
    expect(claimed.violations.map((v) => v.code)).toContain('PRICE_TAMPER');

    // Carrying the injected 90% discount into a payment → over the merchant cap.
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'malicious-001', quantity: 1 }]);
    const payment = await proposePayment(t.ctx, 'buyer-agent-01', mandateId, cart.id, { discountPaise: 674_910 });
    expect(payment.decision).toBe('BLOCK');
    expect(payment.violations.map((v) => v.code)).toContain('MERCHANT_MAX_DISCOUNT_EXCEEDED');
  });

  it('3 · an unknown capability can never become authorized', async () => {
    for (const token of ['root.access', 'admin.all', 'payment.force', 'capability.9999']) {
      const result = await t.ctx.gateway.submitPayload(
        { type: 'catalog.read', query: 'running' },
        { agentId: 'buyer-agent-01', mandateId: null, protocol: 'MCP', requestedCapabilities: [token] },
        { execute: false },
      );
      expect(result.decision).toBe('BLOCK');
      expect(result.violations.map((v) => v.code)).toContain('CAPABILITY_UNKNOWN');
    }
  });

  it('4 · a stale cart cannot be paid without reauthorization', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);

    const proposal = await proposePayment(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(proposal.decision).toBe('ALLOW');

    // Tamper AFTER the authorization decision, BEFORE execution.
    const tamper = await t.ctx.gateway.submitPayload(
      {
        type: 'cart.modify',
        cartId: cart.id,
        items: [
          { productId: 'shoe-001', quantity: 1 },
          { productId: 'sock-001', quantity: 1 },
        ],
        reason: 'swap in socks',
      },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: true },
    );
    expect(tamper.decision).toBe('ALLOW');

    // The pre-tamper decision can no longer execute.
    await expect(t.ctx.payments.executePayment(proposal.decisionId ?? '')).rejects.toMatchObject({
      code: 'CART_CHANGED_AT_EXECUTION',
    });

    // A FRESH proposal on the modified cart is fine — the rejection is about staleness.
    const fresh = await proposePayment(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(fresh.decision).toBe('ALLOW');
  });

  it('5 · an UNKNOWN payment can never be blindly retried', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [
      { productId: 'shoe-001', quantity: 1 },
      { productId: 'sock-001', quantity: 1 },
    ]);
    mockProvider(t.ctx).arm('timeout_then_captured');
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(payment.state).toBe('UNKNOWN');
    const providerCount = mockProvider(t.ctx).listProviderPayments().length;

    const retried = await t.ctx.payments.executePayment(payment.decisionId ?? '');
    expect(retried.id).toBe(payment.id);
    expect(retried.duplicate).toBe(true);
    expect(mockProvider(t.ctx).listProviderPayments()).toHaveLength(providerCount);
    expect(t.ctx.payments.getPayment(payment.id)?.state).toBe('UNKNOWN');

    const report = await t.ctx.reconciliation.reconcile(payment.id);
    expect(report.resolution).toBe('ALREADY_CAPTURED_NO_RETRY');
    expect(report.retried).toBe(false);
  });

  it('6 · a blocked action can never reach the payment provider', async () => {
    const mock = mockProvider(t.ctx);
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);

    const blocked = await t.ctx.gateway.submitPayload(
      { type: 'payment.create', cartId: cart.id, amountPaise: 549_900, discountPaise: 200_000 },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'REST' },
      { execute: true },
    );
    expect(blocked.decision).toBe('BLOCK');
    expect(mock.listProviderPayments()).toHaveLength(0);
    expect(t.ctx.payments.listPayments(10)).toHaveLength(0);
    expect(t.ctx.db.select().from(schema.orders).all()).toHaveLength(0);
  });

  it('7 · a frontend request cannot override backend authorization', async () => {
    const server = await createTestServer();
    try {
      const mandateId = createStandardMandate(server.ctx);
      const cart = await createCart(server.ctx, 'buyer-agent-01', mandateId, [
        { productId: 'shoe-001', quantity: 1 },
        { productId: 'sock-001', quantity: 1 },
      ]);

      // A checkout request carrying an over-cap discount is evaluated server-side.
      const checkout = await post(server.app, '/api/orders', {
        agentId: 'buyer-agent-01',
        mandateId,
        cartId: cart.id,
        discountPaise: 200_000,
      });
      expect(checkout.statusCode).toBe(200);
      const checkoutBody = checkout.json() as {
        decision: string | null;
        decisionId: string | null;
        payment: unknown;
        order: unknown;
      };
      expect(checkoutBody.decision).toBe('BLOCK');
      expect(checkoutBody.payment).toBeNull();
      expect(checkoutBody.order).toBeNull();

      // Executing a BLOCKed decision over HTTP is refused with a structured error.
      const exec = await post(server.app, '/api/payments', { decisionId: checkoutBody.decisionId });
      expect(exec.statusCode).toBe(403);
      expect((exec.json() as { error: { code: string } }).error.code).toBe('DECISION_NOT_AUTHORIZED');

      // Malformed input never crashes the server.
      const malformed = await post(server.app, '/api/carts', { agentId: 42 });
      expect(malformed.statusCode).toBe(400);
      const health = await server.app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect((health.json() as { status: string }).status).toBe('ok');
    } finally {
      await server.close();
    }
  });

  it('8 · a growth agent cannot directly execute payment', async () => {
    await t.ctx.demo.reset();
    const mandateId = t.ctx.mandates.getActiveMandateForUser('demo-user')?.row.id ?? '';
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);

    const upsell = await t.ctx.growth.propose({ mandateId, cartId: cart.id });
    expect(upsell.decision).toBe('ALLOW');

    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(payment.state).toBe('CAPTURED');

    const mock = mockProvider(t.ctx);
    const providerCount = mock.listProviderPayments().length;
    const attempt = await t.ctx.gateway.submitPayload(
      { type: 'payment.create', cartId: cart.id, amountPaise: 779_800, discountPaise: 0 },
      { agentId: 'growth-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: true },
    );
    expect(attempt.decision).toBe('BLOCK');
    expect(mock.listProviderPayments()).toHaveLength(providerCount);

    // There is no provider path at all without an authorization decision.
    await expect(t.ctx.payments.executePayment('dec_missing')).rejects.toMatchObject({
      code: 'DECISION_NOT_FOUND',
    });
  });

  it('9 · an MCP tool cannot bypass the AuthorizationEngine', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const decisionsBefore = t.ctx.authorization.listDecisions({ limit: 200 }).length;

    const created = await t.ctx.adapter.invoke({
      requestId: 'inv-create',
      agentId: 'buyer-agent-01',
      mandateId,
      tool: 'create_cart',
      args: { agentId: 'buyer-agent-01', mandateId, items: [{ productId: 'shoe-001', quantity: 1 }] },
    });
    expect(created.status).toBe('OK');
    expect(t.ctx.authorization.listDecisions({ limit: 200 }).length).toBe(decisionsBefore + 1);

    const cart = created.data as { id: string };
    const tampered = await t.ctx.adapter.invoke({
      requestId: 'inv-pay',
      agentId: 'buyer-agent-01',
      mandateId,
      tool: 'create_payment',
      args: { agentId: 'buyer-agent-01', mandateId, cartId: cart.id, amountPaise: 1, discountPaise: 0 },
    });
    expect(tampered.decision).toBe('BLOCK');
    expect(t.ctx.payments.listPayments(10)).toHaveLength(0);

    const denied = await t.ctx.adapter.invoke({
      requestId: 'inv-refund',
      agentId: 'buyer-agent-01',
      mandateId: null,
      tool: 'refund',
      args: {},
    });
    expect(denied.status).toBe('DENIED');
    expect(t.ctx.payments.listPayments(10)).toHaveLength(0);
  });

  it('10 · historical records never silently change when policies change', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [
      { productId: 'shoe-001', quantity: 1 },
      { productId: 'sock-001', quantity: 1 },
    ]);
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    const decisionId = payment.decisionId ?? '';
    const decisionBefore = t.ctx.authorization.getDecision(decisionId);
    expect(decisionBefore?.policyVersion).toBe(1);
    const eventsBefore = t.ctx.db
      .select()
      .from(schema.auditEvents)
      .orderBy(asc(schema.auditEvents.sequence))
      .all();

    const updated = t.ctx.policies.updatePolicy(t.ctx.merchantId, { maxDiscountRupees: 1_000 }, 'test-user');
    expect(updated.version).toBe(2);

    const decisionAfter = t.ctx.authorization.getDecision(decisionId);
    expect(decisionAfter?.policyVersion).toBe(1);
    expect(decisionAfter?.receipt).toEqual(decisionBefore?.receipt);

    const eventsAfter = t.ctx.db
      .select()
      .from(schema.auditEvents)
      .orderBy(asc(schema.auditEvents.sequence))
      .all();
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);
    for (let i = 0; i < eventsBefore.length; i++) {
      expect(eventsAfter[i]?.eventHash).toBe(eventsBefore[i]?.eventHash);
    }
    expect(t.ctx.audit.verifyChain().valid).toBe(true);

    // And agents can never edit policy.
    expect(() =>
      t.ctx.policies.updatePolicy(t.ctx.merchantId, { maxDiscountRupees: 5_000 }, 'growth-agent-01'),
    ).toThrow(/may not modify merchant policy/);
  });
});