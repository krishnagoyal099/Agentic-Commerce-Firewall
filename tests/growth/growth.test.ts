// tests/growth/growth.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCart, createTestApp, payCart, type TestApp } from '../helpers/testApp';

let t: TestApp;

beforeEach(() => {
  t = createTestApp();
});

afterEach(() => {
  t.close();
});

describe('growth agent and analytics (§30, §31, §69 growth list)', () => {
  it('analytics are computed from real transaction history', async () => {
    const reset = await t.ctx.demo.reset();
    expect(reset.historyOrders).toBe(21);
    expect(reset.historyRevenuePaise).toBeGreaterThan(0);

    const analytics = t.ctx.growth.analytics();
    expect(analytics.length).toBeGreaterThan(0);
    const top = analytics[0];
    expect(top?.productNameA).toBe('Marathon Running Shoes');
    expect(top?.productIdB).toBe('sock-001');
    expect(top?.coPurchaseRate).toBe(0.38);
    expect(top?.avgUpsellPaise).toBe(29_900);
    expect(top?.marginPercent).toBe(42);
    expect(top?.conversionCount).toBe(8);
  });

  it('a growth opportunity becomes a proposal the firewall allows and applies', async () => {
    await t.ctx.demo.reset();
    const mandateId = t.ctx.mandates.getActiveMandateForUser('demo-user')?.row.id ?? '';
    expect(mandateId).not.toBe('');
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);

    const report = await t.ctx.growth.propose({ mandateId, cartId: cart.id });
    expect(report.decision).toBe('ALLOW');
    expect(report.applied).toBe(true);
    expect(report.opportunity?.status).toBe('ALLOWED');
    expect(report.opportunity?.stats?.coPurchaseRate).toBe(0.38);
    expect(t.ctx.carts.getCart(cart.id)?.lines.some((line) => line.productId === 'sock-001')).toBe(true);
    expect(t.ctx.growth.listOpportunities().some((o) => o.id === report.opportunity?.id)).toBe(true);
  });

  it('a growth proposal without a cart is still firewall-evaluated', async () => {
    await t.ctx.demo.reset();
    const mandateId = t.ctx.mandates.getActiveMandateForUser('demo-user')?.row.id ?? '';
    const report = await t.ctx.growth.propose({ mandateId, cartId: null });
    expect(report.decision).toBe('ALLOW');
    expect(report.applied).toBe(false);
    expect(report.opportunity?.status).toBe('ALLOWED');
  });

  it('the growth agent cannot execute payment on a paid cart, and no provider path exists without a decision', async () => {
    await t.ctx.demo.reset();
    const mandateId = t.ctx.mandates.getActiveMandateForUser('demo-user')?.row.id ?? '';
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    await t.ctx.growth.propose({ mandateId, cartId: cart.id });
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(payment.state).toBe('CAPTURED');

    const attempt = await t.ctx.gateway.submitPayload(
      { type: 'payment.create', cartId: cart.id, amountPaise: 779_800, discountPaise: 0 },
      { agentId: 'growth-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: true },
    );
    expect(attempt.decision).toBe('BLOCK');
    expect(attempt.violations.map((v) => v.code)).toContain('PAYMENT_DUPLICATE');

    await expect(t.ctx.payments.executePayment('dec_nonexistent')).rejects.toMatchObject({
      code: 'DECISION_NOT_FOUND',
    });
  });
});