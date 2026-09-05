// tests/drift/drift.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRIFT_WEIGHTS, clamp01, computeOverallDrift, type DriftDimension } from '@acsf/shared';
import { createCart, createStandardMandate, createTestApp, type TestApp } from '../helpers/testApp';

let t: TestApp;

beforeEach(() => {
  t = createTestApp();
});

afterEach(() => {
  t.close();
});

function breakdownFor(mandateId: string) {
  const mandateView = t.ctx.mandates.getMandate(mandateId);
  const policy = t.ctx.policies.getActivePolicy(t.ctx.merchantId);
  if (mandateView === null || policy === null) throw new Error('fixture missing');
  const session = t.ctx.drift.getSession('buyer-agent-01', mandateId, 'INTERNAL');
  return t.ctx.drift.computeBreakdown(session, mandateView.row, policy, t.clock.now());
}

describe('authority drift (§23, §24, §69)', () => {
  it('weights sum to 1 and the formula is exact', () => {
    const dims: DriftDimension[] = ['monetary', 'category', 'discount', 'temporal', 'action'];
    expect(dims.reduce((sum, d) => sum + DRIFT_WEIGHTS[d], 0)).toBeCloseTo(1, 10);
    expect(computeOverallDrift({ monetary: 1, category: 0, discount: 0, temporal: 0, action: 0 })).toBeCloseTo(0.3, 5);
    expect(computeOverallDrift({ monetary: 0, category: 1, discount: 0, temporal: 0, action: 0 })).toBeCloseTo(0.25, 5);
    expect(computeOverallDrift({ monetary: 0, category: 0, discount: 1, temporal: 0, action: 0 })).toBeCloseTo(0.2, 5);
    expect(computeOverallDrift({ monetary: 0, category: 0, discount: 0, temporal: 1, action: 0 })).toBeCloseTo(0.1, 5);
    expect(computeOverallDrift({ monetary: 0, category: 0, discount: 0, temporal: 0, action: 1 })).toBeCloseTo(0.15, 5);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(-1)).toBe(0);
  });

  it('a normal on-intent purchase produces near-zero drift', async () => {
    const mandateId = createStandardMandate(t.ctx);
    await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const b = breakdownFor(mandateId);
    expect(b.monetary).toBe(0);
    expect(b.category).toBe(0);
    expect(b.discount).toBe(0);
    expect(b.temporal).toBeCloseTo(0, 5);
    expect(b.action).toBe(0);
    expect(b.overall).toBeLessThan(0.05);
    expect(b.explanation.overall).toContain('Weighted sum');
  });

  it('an accessory upsell produces moderate drift', async () => {
    const mandateId = createStandardMandate(t.ctx);
    await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'sock-001', quantity: 1 }]);
    const b = breakdownFor(mandateId);
    expect(b.monetary).toBeCloseTo(0.15, 3); // 29,900 / 200,000 cushion
    expect(b.category).toBeCloseTo(0.219, 3); // 1.25×avg(0,0.25) + 0.25×0.25
    expect(b.action).toBe(0.25); // 1 scope-expanding attempt / 4
    expect(b.overall).toBeGreaterThan(0.05);
    expect(b.overall).toBeLessThan(0.4);
  });

  it('unrelated categories produce high drift', async () => {
    const mandateId = createStandardMandate(t.ctx);
    await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'warranty-001', quantity: 1 }]);
    await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'warranty-001', quantity: 1 }]);
    const b = breakdownFor(mandateId);
    expect(b.monetary).toBe(1); // 800,000 non-core ≥ 200,000 cushion
    expect(b.category).toBe(1); // distances [0.7, 0.7] → 1.05 clamped
    expect(b.overall).toBeGreaterThanOrEqual(0.6);
  });

  it('temporal drift measures the fraction of mandate lifetime consumed', async () => {
    const mandateId = createStandardMandate(t.ctx, { ttlHours: 24 });
    await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    t.clock.advanceHours(12);
    expect(breakdownFor(mandateId).temporal).toBeCloseTo(0.5, 3);
    t.clock.advanceHours(12);
    expect(breakdownFor(mandateId).temporal).toBe(1);
  });

  it('scope-expanding (off-intent) actions drive action drift, clamped at 1.0', async () => {
    const mandateId = createStandardMandate(t.ctx);
    for (let i = 0; i < 4; i++) {
      await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'warranty-001', quantity: 1 }]);
    }
    expect(breakdownFor(mandateId).action).toBe(1);
    await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'warranty-001', quantity: 1 }]);
    expect(breakdownFor(mandateId).action).toBe(1);
  });
});