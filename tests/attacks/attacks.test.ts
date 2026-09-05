// tests/attacks/attacks.test.ts
import { describe, expect, it } from 'vitest';
import { ATTACKS, type AttackName, type Decision } from '@acsf/shared';
import { createTestApp, type TestApp } from '../helpers/testApp';

const EXPECTED: Record<AttackName, Decision> = {
  unauthorized_discount: 'BLOCK',
  malicious_catalog: 'BLOCK',
  stale_cart: 'REAUTHORIZE',
  payment_timeout: 'BLOCK',
  slow_authority_drift: 'HUMAN_APPROVAL',
  budget_exhaustion: 'BLOCK',
  unauthorized_refund: 'BLOCK',
  capability_escalation: 'BLOCK',
  protocol_bypass: 'BLOCK',
  duplicate_payment: 'BLOCK',
};

describe('attack lab (§38, §69 — every built-in attack has a test)', () => {
  for (const name of ATTACKS) {
    it(`${name} → ${EXPECTED[name]}`, async () => {
      const t = createTestApp();
      try {
        const report = await t.ctx.attackService.run(name);
        expect(report.attack).toBe(name);
        expect(report.decision).toBe(EXPECTED[name]);
        expect(report.steps.length).toBeGreaterThanOrEqual(4);
        expect(report.auditEventId).not.toBeNull();
        expect(t.ctx.audit.verifyChain().valid).toBe(true);
      } finally {
        t.close();
      }
    });
  }

  it('specific rule violations and drift are reported per attack', async () => {
    const t = createTestApp();
    try {
      const discount = await t.ctx.attackService.run('unauthorized_discount');
      expect(discount.violatedRule).toContain('MERCHANT_MAX_DISCOUNT_EXCEEDED');

      const catalog = await t.ctx.attackService.run('malicious_catalog');
      expect(catalog.violatedRule).toContain('PRICE_TAMPER');

      const stale = await t.ctx.attackService.run('stale_cart');
      expect(stale.violatedRule).toContain('CART_STALE');

      const drift = await t.ctx.attackService.run('slow_authority_drift');
      expect(drift.drift).not.toBeNull();
      expect(drift.drift ?? 0).toBeGreaterThan(0.7);
      expect(drift.drift ?? 0).toBeLessThanOrEqual(0.9);

      const bypass = await t.ctx.attackService.run('protocol_bypass');
      expect(bypass.violatedRule).toContain('CAPABILITY_PRIVILEGED');
    } finally {
      t.close();
    }
  });

  it('unknown attack names fail closed', async () => {
    const t = createTestApp();
    try {
      await expect(
        t.ctx.attackService.run('not_an_attack' as unknown as AttackName),
      ).rejects.toMatchObject({ code: 'UNKNOWN_ATTACK' });
    } finally {
      t.close();
    }
  });
});