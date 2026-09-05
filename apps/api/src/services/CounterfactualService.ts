// apps/api/src/services/CounterfactualService.ts
import type { Database as SqliteDatabase } from 'better-sqlite3';
import {
  ACTOR_IDS,
  type CartDTO,
  type CounterfactualParameter,
  type CounterfactualResponse,
  type CounterfactualResult,
} from '@acsf/shared';
import { buildServiceContext } from '../context';
import { cloneDatabase, handleFromSqlite } from '../db/client';
import { ProtocolGateway } from '../protocol/ProtocolGateway';
import { SystemClock } from '../utils/clock';
import type { ServiceContext } from '../context';

export interface CounterfactualInput {
  parameter: CounterfactualParameter;
  /** Values in paise. */
  values: number[];
}

const COUNTERFACTUAL_INTENT = 'I need running shoes for marathon training under ₹8,000';
const MAX_VALUES = 12;

/**
 * Catalog compositions used to reach exact target amounts for the amountPaise
 * parameter: the first combo whose subtotal lies within ₹500 above the target
 * is selected, and the remainder becomes the cart discount (≤ ₹500 cap).
 */
const COMBOS: ReadonlyArray<ReadonlyArray<{ productId: string; quantity: number }>> = [
  [{ productId: 'shoe-001', quantity: 1 }],
  [{ productId: 'shoe-001', quantity: 1 }, { productId: 'sock-001', quantity: 1 }],
  [{ productId: 'shoe-001', quantity: 1 }, { productId: 'bottle-001', quantity: 1 }],
  [{ productId: 'shoe-001', quantity: 1 }, { productId: 'insole-001', quantity: 1 }],
  [
    { productId: 'shoe-001', quantity: 1 },
    { productId: 'sock-001', quantity: 1 },
    { productId: 'bottle-001', quantity: 1 },
  ],
  [
    { productId: 'shoe-001', quantity: 1 },
    { productId: 'sock-001', quantity: 1 },
    { productId: 'insole-001', quantity: 1 },
  ],
  [
    { productId: 'shoe-001', quantity: 1 },
    { productId: 'sock-001', quantity: 1 },
    { productId: 'bottle-001', quantity: 1 },
    { productId: 'insole-001', quantity: 1 },
  ],
  [
    { productId: 'shoe-001', quantity: 1 },
    { productId: 'sock-001', quantity: 1 },
    { productId: 'bottle-001', quantity: 1 },
    { productId: 'insole-001', quantity: 1 },
    { productId: 'warranty-001', quantity: 1 },
  ],
  [{ productId: 'watch-001', quantity: 1 }],
  [{ productId: 'laptop-001', quantity: 1 }],
];

/**
 * Counterfactual authorization (§46). Each value runs the SAME backend
 * AuthorizationEngine on a throwaway in-memory clone of live state (fresh
 * mandate per value → fresh drift session → comparable results). Zero real
 * financial state is mutated: sandbox writes are discarded with the clone.
 */
export class CounterfactualService {
  constructor(private readonly ctx: ServiceContext) {}

  async evaluate(input: CounterfactualInput): Promise<CounterfactualResponse> {
    const pristine = await cloneDatabase(this.ctx.sqlite);
    try {
      const results: CounterfactualResult[] = [];
      const skipped: number[] = [];
      for (const value of input.values.slice(0, MAX_VALUES)) {
        const sandbox = await cloneDatabase(pristine);
        try {
          const outcome = await this.runScenario(sandbox, input.parameter, value);
          if ('skipped' in outcome) {
            skipped.push(value);
            console.log(`[counterfactual] value ${value} skipped:`, outcome.skipped);
          } else {
            results.push(outcome);
          }
        } finally {
          sandbox.close();
        }
      }
      const note =
        'Counterfactuals executed the real backend AuthorizationEngine on throwaway clones of live state — zero real financial state was mutated.' +
        (skipped.length > 0 ? ` Skipped unsupported value(s): ${skipped.map((v) => `₹${(v / 100).toFixed(2)}`).join(', ')}.` : '');
      return { parameter: input.parameter, results, note };
    } finally {
      pristine.close();
    }
  }

  private async runScenario(
    sqlite: SqliteDatabase,
    parameter: CounterfactualParameter,
    value: number,
  ): Promise<CounterfactualResult | { skipped: string }> {
    const handle = handleFromSqlite(sqlite);
    const clock = new SystemClock();
    // Force the mock provider: the scenario only *evaluates* a payment (never
    // executes one), but consistency demands a providerless-dependency sandbox.
    const config = { ...this.ctx.config, paymentProvider: 'mock' as const, razorpayKeyId: null, razorpayKeySecret: null };
    const services = buildServiceContext(handle, clock, config);
    const gateway = new ProtocolGateway(services);
    const price = (productId: string): number => services.catalog.getProduct(productId)?.pricePaise ?? 0;

    const mandateRupees = parameter === 'mandateMaxPaise' ? Math.floor(value / 100) : 8_000;
    if (mandateRupees < 1) {
      return { skipped: 'mandate cap below ₹1' };
    }
    if (parameter === 'mandateMaxPaise' && value % 100 !== 0) {
      return { skipped: 'mandate cap must be a whole-rupee amount' };
    }


    let items: Array<{ productId: string; quantity: number }>;
    let discountPaise = 0;
    let amountPaise: number;
    let cartSubtotalPaise = 0;
    if (parameter === 'amountPaise') {
      const combo = COMBOS.find((candidate) => {
        const subtotal = candidate.reduce((sum, item) => sum + price(item.productId) * item.quantity, 0);
        return value <= subtotal && subtotal - value <= 50_000;
      });
      if (combo === undefined) {
        return { skipped: 'no catalog composition reaches that amount within the ₹500 discount window' };
      }
      items = combo.map((item) => ({ ...item }));
      cartSubtotalPaise = combo.reduce((sum, item) => sum + price(item.productId) * item.quantity, 0);
      discountPaise = cartSubtotalPaise - value;
      amountPaise = value;
    } else {
      items = [
        { productId: 'shoe-001', quantity: 1 },
        { productId: 'sock-001', quantity: 1 },
      ];
      cartSubtotalPaise = items.reduce((sum, item) => sum + price(item.productId) * item.quantity, 0);
      discountPaise = parameter === 'discountPaise' ? value : 0;
      amountPaise = parameter === 'discountPaise' ? cartSubtotalPaise - value : cartSubtotalPaise;
    }

    // Fresh mandate per value → fresh drift session → values are comparable.
    // For amountPaise: the mandate cap must cover the full cart subtotal so cart.create
    // is ALLOWed. We then lower the cap to ₹8,000 before payment.create so that the
    // payment evaluation exercises the canonical ₹8,000 mandate boundary.
    const mandateCapRupees =
      parameter === 'mandateMaxPaise'
        ? Math.floor(value / 100)
        : parameter === 'amountPaise'
          ? Math.ceil(cartSubtotalPaise / 100) + 1  // covers full subtotal; lowered before payment eval
          : 8_000;

    const mandate = services.mandates.createMandate(
      {
        userId: 'counterfactual-user',
        intent: COUNTERFACTUAL_INTENT,
        maxAmountRupees: mandateCapRupees,
        allowedCategories: ['running_shoes', 'running_accessories'],
        allowUpsell: true,
        ttlHours: 24,
      },
      'counterfactual-user',
    );

    const creation = await gateway.submitPayload(
      { type: 'cart.create', items },
      { agentId: ACTOR_IDS.buyerAgentId, mandateId: mandate.row.id, protocol: 'INTERNAL' },
      { execute: true },
    );
    const cart =
      typeof creation.data === 'object' && creation.data !== null && 'lines' in creation.data
        ? (creation.data as CartDTO)
        : null;
    if (cart === null || creation.decision !== 'ALLOW') {
      return { skipped: `cart creation returned ${creation.decision ?? 'ERROR'}` };
    }

    // For amountPaise: after cart creation with the wide mandate, narrow the mandate's
    // maxAmountPaise to the canonical ₹8,000 cap directly in the cloned DB.
    // This keeps the same mandateId (so the cart ownership check passes) while forcing
    // the engine's payment.create mandate-amount check to test the ₹8,000 boundary.
    if (parameter === 'amountPaise') {
      sqlite.prepare('UPDATE mandates SET max_amount_paise = ? WHERE id = ?').run(800000, mandate.row.id);
    }

    const proposal = await gateway.submitPayload(
      { type: 'payment.create', cartId: cart.id, amountPaise, discountPaise },
      { agentId: ACTOR_IDS.buyerAgentId, mandateId: mandate.row.id, protocol: 'INTERNAL' },
      { execute: false },
    );
    return {
      parameter,
      value,
      decision: proposal.decision ?? 'BLOCK',
      reason: proposal.reason ?? proposal.error?.message ?? 'no reason returned',
      drift: proposal.drift?.overall ?? null,
    };
  }
}