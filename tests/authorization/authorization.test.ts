// tests/authorization/authorization.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAction } from '@acsf/shared';
import {
  createCart,
  createStandardMandate,
  createTestApp,
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

describe('AuthorizationEngine decisions (§69)', () => {
  it('a fully compliant order → ALLOW', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [
      { productId: 'shoe-001', quantity: 1 },
      { productId: 'sock-001', quantity: 1 },
    ]);
    expect(cart.totalPaise).toBe(779_800);

    const proposal = await proposePayment(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(proposal.decision).toBe('ALLOW');
    expect(proposal.violations).toHaveLength(0);
    expect(proposal.receipt?.intent?.maxAmountPaise).toBe(800_000);
    expect(proposal.receipt?.policy?.version).toBe(1);

    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(payment.state).toBe('CAPTURED');
  });

  it('an order above the mandate cap → REAUTHORIZE', async () => {
    const mandateId = createStandardMandate(t.ctx, { maxAmountRupees: 7_600 });
    const result = await t.ctx.gateway.submitPayload(
      {
        type: 'cart.create',
        items: [
          { productId: 'shoe-001', quantity: 1 },
          { productId: 'sock-001', quantity: 1 },
        ],
      },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: false },
    );
    expect(result.decision).toBe('REAUTHORIZE');
    expect(result.violations.map((v) => v.code)).toContain('MANDATE_AMOUNT_EXCEEDED');
  });

  it('an order above the merchant hard limit → BLOCK', async () => {
    const mandateId = createStandardMandate(t.ctx, {
      maxAmountRupees: 100_000,
      allowedCategories: ['running_shoes', 'running_accessories', 'sports', 'electronics', 'warranty'],
    });
    const result = await t.ctx.gateway.submitPayload(
      { type: 'cart.create', items: [{ productId: 'laptop-001', quantity: 1 }] },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: false },
    );
    expect(result.decision).toBe('BLOCK');
    expect(result.violations.map((v) => v.code)).toContain('MERCHANT_MAX_ORDER_EXCEEDED');
  });

  it('a discount above the merchant cap → BLOCK (and never reaches the provider)', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const result = await t.ctx.gateway.submitPayload(
      { type: 'payment.create', cartId: cart.id, amountPaise: cart.subtotalPaise - 200_000, discountPaise: 200_000 },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: true },
    );
    expect(result.decision).toBe('BLOCK');
    expect(result.violations.map((v) => v.code)).toContain('MERCHANT_MAX_DISCOUNT_EXCEEDED');
    expect(result.executed).toBe(false);
    expect(mockProvider(t.ctx).listProviderPayments()).toHaveLength(0);
  });

  it('an unauthorized capability → BLOCK', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const result = await t.ctx.gateway.submitPayload(
      { type: 'upsell.create', cartId: cart.id, items: [{ productId: 'sock-001', quantity: 1 }], pitch: 'test' },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: false },
    );
    expect(result.decision).toBe('BLOCK');
    expect(result.violations.map((v) => v.code)).toContain('CAPABILITY_NOT_GRANTED');
  });

  it('an expired mandate → REAUTHORIZE', async () => {
    const mandateId = createStandardMandate(t.ctx, { ttlHours: 1 });
    t.clock.advanceHours(2);
    const result = await t.ctx.gateway.submitPayload(
      { type: 'cart.create', items: [{ productId: 'shoe-001', quantity: 1 }] },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: false },
    );
    expect(result.decision).toBe('REAUTHORIZE');
    expect(result.violations.map((v) => v.code)).toContain('MANDATE_EXPIRED');
  });

  it('a stale cart (modified after authorization) → REAUTHORIZE', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    mockProvider(t.ctx).arm('timeout_then_captured');
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(payment.state).toBe('UNKNOWN');
    expect(t.ctx.carts.getCart(cart.id)?.cart.state).toBe('authorized');

    const tamper = await t.ctx.gateway.submitPayload(
      { type: 'cart.add_item', cartId: cart.id, items: [{ productId: 'sock-001', quantity: 1 }] },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: true },
    );
    expect(tamper.decision).toBe('ALLOW'); // individually plausible…
    expect(t.ctx.carts.getCart(cart.id)?.cart.state).toBe('stale'); // …but the cart is now stale

    const repay = await proposePayment(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(repay.decision).toBe('REAUTHORIZE');
    expect(repay.violations.map((v) => v.code)).toContain('CART_STALE');
  });

  it('daily budget exhaustion → BLOCK', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [
      { productId: 'shoe-001', quantity: 1 },
      { productId: 'sock-001', quantity: 1 },
    ]);
    t.ctx.policies.updatePolicy(t.ctx.merchantId, { dailyBudgetRupees: 300 }, 'test-user');
    const result = await proposePayment(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(result.decision).toBe('BLOCK');
    expect(result.violations.map((v) => v.code)).toContain('MERCHANT_DAILY_BUDGET_EXCEEDED');
  });

  it('authority drift above the approval threshold → HUMAN_APPROVAL', async () => {
    const mandateId = createStandardMandate(t.ctx);
    await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'warranty-001', quantity: 1 }]);
    const second = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'warranty-001', quantity: 1 }]);
    const modify = await t.ctx.gateway.submitPayload(
      { type: 'cart.modify', cartId: second.id, discountPaise: 50_000 },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: false },
    );
    expect(modify.decision).toBe('HUMAN_APPROVAL');
    expect(modify.violations.map((v) => v.code)).toContain('DRIFT_APPROVAL_THRESHOLD');
    expect(modify.drift?.overall).toBeGreaterThan(0.7);
    expect(modify.drift?.overall).toBeLessThanOrEqual(0.9);
  });

  it('human approval unlocks execution exactly once; agents can never approve', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cartA = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'warranty-001', quantity: 1 }]);
    const cartB = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'warranty-001', quantity: 1 }]);

    const firstModify = await t.ctx.gateway.submitPayload(
      { type: 'cart.modify', cartId: cartB.id, discountPaise: 50_000 },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: false },
    );
    expect(firstModify.decision).toBe('HUMAN_APPROVAL');
    const secondModify = await t.ctx.gateway.submitPayload(
      { type: 'cart.modify', cartId: cartA.id, discountPaise: 50_000 },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: false },
    );
    expect(secondModify.decision).toBe('HUMAN_APPROVAL');

    // The acting agent can never approve its own request.
    expect(() =>
      t.ctx.authorization.recordHumanApproval(secondModify.decisionId ?? '', 'buyer-agent-01', 'approved'),
    ).toThrow(/is an agent/);

    // Rejection leaves execution forbidden.
    const rejected = t.ctx.authorization.recordHumanApproval(secondModify.decisionId ?? '', 'test-user', 'rejected');
    expect(rejected.decision.approvedAt).toBeNull();
    expect(() =>
      t.ctx.carts.modifyCart(cartA.id, { items: null, discountPaise: 50_000 }, 'buyer', secondModify.decisionId ?? ''),
    ).toThrow(/does not authorize execution/);

    // Approval unlocks execution exactly once.
    const approved = t.ctx.authorization.recordHumanApproval(firstModify.decisionId ?? '', 'test-user', 'approved');
    expect(approved.decision.approvedAt).not.toBeNull();
    const view = t.ctx.carts.modifyCart(cartB.id, { items: null, discountPaise: 50_000 }, 'buyer', firstModify.decisionId ?? '');
    expect(view.cart.discountPaise).toBe(50_000);
    expect(() =>
      t.ctx.carts.modifyCart(cartB.id, { items: null, discountPaise: 50_000 }, 'buyer', firstModify.decisionId ?? ''),
    ).toThrow(/already executed/);
  });

  it('structurally malformed proposals → BLOCK (fail closed, no crash)', async () => {
    const action: AgentAction = {
      actionId: 'malformed-1',
      type: 'catalog.read',
      agentId: 'buyer-agent-01',
      mandateId: null,
      cartId: null,
      protocol: 'REST',
      requestedCapabilities: [],
      timestamp: t.clock.now().toISOString(),
      idempotencyKey: 'malformed-key-1',
      query: 'x'.repeat(300),
    };
    const result = await t.ctx.gateway.submit(action, { execute: false });
    expect(result.decision).toBe('BLOCK');
    expect(result.violations.map((v) => v.code)).toContain('MALFORMED_PROPOSAL');
    expect(t.ctx.audit.verifyChain().valid).toBe(true);
  });
});