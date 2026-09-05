// apps/api/src/services/DemoService.ts  (MODIFIED — intent-driven reset/start)
import { eq } from 'drizzle-orm';
import {
  ACTOR_IDS,
  CATEGORIES,
  CATEGORY_LABELS,
  DEMO_INTENT,
  formatINR,
  paiseToRupees,
  renderReceipt,
  type BuyerPurchaseReport,
  type CartDTO,
  type Category,
  type DemoBootstrapResult,
  type DemoResetReport,
  type DemoStartReport,
  type GrowthAgentReport,
  type MandatePlan,
  type PaymentDTO,
} from '@acsf/shared';
import type { DatabaseHandle } from '../db/client';
import { ensureHistoryAgent, HISTORY_AGENT_ID, resetTransactionalState, seedDatabase } from '../db/seed';
import type { ServiceContext } from '../context';
import { buildServiceContext } from '../context';
import { ProtocolGateway } from '../protocol/ProtocolGateway';
import { FixedClock } from '../utils/clock';
import { DomainError } from '../utils/errors';
import { sha256JSON } from '../utils/hash';
import type { BuyerAgent } from './BuyerAgent';
import type { GrowthAgent } from './GrowthAgent';
import type { IntentService } from './IntentService';
import type { MetricsService } from './MetricsService';
import * as schema from '../db/schema';

/** What the user asks for. Everything is optional; omitted → the demo default. */
export interface DemoRunOptions {
  intent?: string;
  maxAmountRupees?: number;
  allowedCategories?: string[];
  allowUpsell?: boolean;
  ttlHours?: number;
}

/**
 * Shape of the generated transaction history: which past days had orders, and
 * which of those orders included the companion product. 21 orders, 8 of them
 * paired, which works out to a ~38% co-purchase rate.
 *
 * Be precise about what is real here: this SHAPE is a designed fixture — it
 * exists so the analytics have a realistic pattern to chew on. The rate itself
 * is never stored or read back; GrowthAnalytics counts it from the resulting
 * orders. The PRODUCTS filled into the shape are resolved from the user's
 * intent, so the same shape produces warranty+bottle history for a warranty
 * intent and shoe+sock history for a shoe intent.
 */
const HISTORY_SHAPE: ReadonlyArray<{ daysAgo: number; pairs: readonly boolean[] }> = [
  { daysAgo: 12, pairs: [false, false, true, false] },
  { daysAgo: 10, pairs: [true, false, true] },
  { daysAgo: 8, pairs: [false, true, false] },
  { daysAgo: 6, pairs: [true, false, false, true] },
  { daysAgo: 5, pairs: [false, true, false, false, false] },
  { daysAgo: 3, pairs: [true, false] },
];

/**
 * START DEMO / RESET DEMO (§64, §65) driven by the user's OWN intent.
 *
 * Reset is safe to repeat: wipe → seed reference data → regenerate history
 * through real flows around the intent's product → issue a fresh mandate from
 * the parsed plan. Start additionally drives buyer → growth → payment
 * end-to-end. The intent influences only what authority is REQUESTED; every
 * decision afterwards is still made by the deterministic AuthorizationEngine.
 */
export class DemoService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly handle: DatabaseHandle,
    private readonly gateway: ProtocolGateway,
    private readonly buyer: BuyerAgent,
    private readonly growth: GrowthAgent,
    private readonly metrics: MetricsService,
    private readonly intent: IntentService,
  ) {}

  /** Bootstraps on first run so the dashboard is meaningful immediately. */
  async ensureBootstrapped(): Promise<DemoBootstrapResult> {
    const completed = this.ctx.db
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(eq(schema.orders.status, 'completed'))
      .all().length;
    const activeMandate = this.ctx.mandates.getActiveMandateForUser(ACTOR_IDS.userId);
    if (completed > 0 && activeMandate !== null) {
      return { bootstrapped: false, reset: null };
    }
    return { bootstrapped: true, reset: await this.reset() };
  }

  /**
   * Resolves the run's mandate plan. With no user intent this stays entirely
   * offline (deterministic parser on the demo default), so server startup never
   * depends on an LLM being reachable.
   */
  private async resolvePlan(options: DemoRunOptions): Promise<MandatePlan> {
    const overrides = {
      maxAmountRupees: options.maxAmountRupees,
      allowedCategories: options.allowedCategories,
      allowUpsell: options.allowUpsell,
      ttlHours: options.ttlHours,
    };
    const raw = options.intent?.trim();
    if (raw === undefined || raw.length === 0) {
      return this.intent.deterministicPlan(DEMO_INTENT);
    }
    if (raw.length < 5) {
      throw new DomainError('INVALID_INTENT', 'Describe what you want in at least a few words.');
    }
    const report = await this.intent.plan(raw, overrides);
    return report.plan;
  }

  async reset(options: DemoRunOptions = {}): Promise<DemoResetReport> {
    const plan = await this.resolvePlan(options);
    if (plan.allowedCategories.length === 0) {
      throw new DomainError(
        'INVALID_INTENT',
        `Nothing in "${plan.intent}" matches a stocked category. This merchant sells: ${CATEGORIES.map((c) => CATEGORY_LABELS[c]).join(', ')}.`,
      );
    }

    // Transactions, decisions and audit are wiped; the merchant's catalog,
    // policy versions and agent registry survive (§64). seedDatabase is
    // idempotent on merchant presence, so it only fills a brand-new database.
    resetTransactionalState(this.ctx.db);
    seedDatabase(this.ctx.db, this.ctx.clock);
    ensureHistoryAgent(this.ctx.db, this.ctx.clock);

    // The wipe removes the audit chain but deliberately keeps the merchant's
    // policy versions and catalog — including any the merchant edited, whose
    // only provenance was the POLICY_CHANGE / CATALOG_CHANGE events just
    // deleted. Without this, the new chain verifies as intact over a
    // configuration it has no record of. Genesis now names what survived.
    const survivingPolicy = this.ctx.policies.getActivePolicy(this.ctx.merchantId);
    const catalogSize = this.ctx.catalog.listProducts().length;
    this.ctx.audit.append({
      actor: 'demo-service',
      eventType: 'SYSTEM',
      action: 'demo.reset',
      reason:
        `Demo reset: transactions, decisions and the previous audit chain were cleared. ` +
        `Surviving merchant configuration — policy v${survivingPolicy?.version ?? '—'} ` +
        `(per-order ${survivingPolicy !== null ? formatINR(survivingPolicy.maxOrderAmountPaise) : '—'}, ` +
        `daily ${survivingPolicy !== null ? formatINR(survivingPolicy.dailyBudgetPaise) : '—'}), ` +
        `${catalogSize} catalog product(s) — predates this chain.`,
      inputHash: sha256JSON({ reset: true, policyVersion: survivingPolicy?.version ?? null, catalogSize }),
      policyVersion: survivingPolicy?.version ?? null,
      payload: {
        policyVersion: survivingPolicy?.version ?? null,
        maxOrderAmountPaise: survivingPolicy?.maxOrderAmountPaise ?? null,
        maxDiscountPaise: survivingPolicy?.maxDiscountPaise ?? null,
        dailyBudgetPaise: survivingPolicy?.dailyBudgetPaise ?? null,
        catalogSize,
      },
    });

    // The intent's own product first; otherwise the closest pair the live
    // catalog can offer, ranked by relevance to the categories the shopper
    // asked for. There is deliberately no named seed product to fall back on —
    // if the catalog cannot supply an anchor, that is a real error, not a shoe.
    const fallback = this.intent.fallbackHistoryPair(plan.allowedCategories);
    const anchorProductId = plan.anchorProductId ?? fallback.anchorProductId;
    if (anchorProductId === null) {
      throw new DomainError(
        'EMPTY_CATALOG',
        'No active product is priced within the merchant policy, so no transaction history can be generated. Add a product the policy can clear, or restore the demo catalog.',
      );
    }
    const companionProductId =
      plan.anchorProductId !== null ? plan.companionProductId : fallback.companionProductId;
    const adaptive = plan.anchorProductId !== null;

    // When the intent's own products are unsellable under the merchant policy,
    // say so plainly — silently substituting a different anchor is exactly what
    // makes the growth analytics look hardcoded.
    // IntentService.plan() already attaches this when it builds the plan; the
    // guard keeps a RESET driven by an already-planned mandate from showing the
    // same sentence to the user twice.
    const obstacle = this.intent.historyAnchorObstacle(plan);
    if (obstacle !== null && !plan.warnings.includes(obstacle)) {
      plan.warnings = [...plan.warnings, obstacle];
    }

    const history = await this.bootstrapHistory(plan, anchorProductId, companionProductId);

    const mandate = this.ctx.mandates.createMandate(
      {
        userId: ACTOR_IDS.userId,
        intent: plan.intent,
        maxAmountRupees: plan.maxAmountRupees,
        allowedCategories: plan.allowedCategories,
        allowUpsell: plan.allowUpsell,
        ttlHours: plan.ttlHours,
      },
      ACTOR_IDS.userId,
    );
    this.ctx.audit.append({
      actor: 'system',
      eventType: 'SYSTEM',
      action: 'demo.reset',
      reason: `Demo state restored for intent "${plan.intent}": reference data reseeded, ${history.orders} history orders generated through real flows, fresh mandate issued.`,
      inputHash: sha256JSON({
        intent: plan.intent,
        historyOrders: history.orders,
        historyRevenuePaise: history.revenuePaise,
      }),
      payload: {
        intent: plan.intent,
        planSource: plan.source,
        allowedCategories: plan.allowedCategories,
        maxAmountRupees: plan.maxAmountRupees,
        historyOrders: history.orders,
        historyRevenuePaise: history.revenuePaise,
        historyAnchorProductId: anchorProductId,
        historyCompanionProductId: companionProductId,
        mandateId: mandate.row.id,
      },
    });
    return {
      reset: true,
      historyOrders: history.orders,
      historyRevenuePaise: history.revenuePaise,
      mandateId: mandate.row.id,
      resetAt: this.ctx.clock.now().toISOString(),
      note: `Reference data reseeded; ${history.orders} history orders regenerated through real cart/authorization/payment operations at past timestamps around ${history.anchorName}; fresh mandate issued from the user's intent.`,
      plan,
      history: { anchorProductId, companionProductId, adaptive },
    };
  }

  /** Last resort: the shipped anchor, but only if the merchant still stocks it. */
  async start(options: DemoRunOptions = {}): Promise<DemoStartReport> {
    const resetReport = await this.reset(options);
    const mandateId = resetReport.mandateId;

    const buyer = await this.buyer.run(mandateId);
    let growth: GrowthAgentReport;
    let purchase: BuyerPurchaseReport | null = null;
    if (buyer.cartId !== null) {
      growth = await this.growth.propose({ mandateId, cartId: buyer.cartId });
      purchase = await this.buyer.purchase(mandateId, buyer.cartId);
      if (
        purchase.payment !== null &&
        purchase.payment.state === 'CAPTURED' &&
        growth.opportunity !== null
      ) {
        this.growth.markConverted(growth.opportunity.id);
      }
    } else {
      growth = await this.growth.propose({ mandateId, cartId: null });
    }

    const metrics = this.metrics.snapshot();
    const auditChain = this.ctx.audit.verifyChain();
    const receipt =
      purchase !== null && purchase.decisionId !== null
        ? this.ctx.authorization.getDecisionReceipt(purchase.decisionId)
        : null;

    this.ctx.audit.append({
      actor: 'system',
      eventType: 'SYSTEM',
      action: 'demo.started',
      reason: `Demo sequence completed for "${resetReport.plan.intent}": buyer ${buyer.finalState}; growth ${growth.decision ?? 'no data'}; purchase ${purchase?.finalState ?? 'skipped'}.`,
      inputHash: sha256JSON({ mandateId, buyerState: buyer.finalState, purchaseState: purchase?.finalState ?? 'skipped' }),
      payload: {
        mandateId,
        intent: resetReport.plan.intent,
        cartId: buyer.cartId,
        paymentId: purchase?.payment?.id ?? null,
        orderId: purchase?.order?.id ?? null,
      },
    });

    return {
      reset: resetReport,
      buyer,
      growth,
      purchase,
      metrics,
      auditChain,
      receiptText: receipt !== null ? renderReceipt(receipt) : null,
      finalState: purchase?.finalState ?? buyer.finalState,
      startedAt: this.ctx.clock.now().toISOString(),
    };
  }

  /**
   * Generates history through real flows over pinned past clocks. Each day gets
   * its own throwaway ServiceContext + ProtocolGateway (sharing the database
   * handle) so every mandate, cart, decision, payment, order, and audit event is
   * created by the real domain code at a past timestamp.
   *
   * The anchor/companion pair comes from the user's intent, so the growth
   * agent's co-purchase analytics are about what THIS user is buying.
   */
  private async bootstrapHistory(
    plan: MandatePlan,
    anchorProductId: string,
    companionProductId: string | null,
  ): Promise<{ orders: number; revenuePaise: number; anchorName: string }> {
    const anchor = this.ctx.catalog.getProduct(anchorProductId);
    if (anchor === null) {
      throw new DomainError('INVALID_INTENT', `History anchor product ${anchorProductId} is not in the catalog.`);
    }
    const companion =
      companionProductId !== null ? this.ctx.catalog.getProduct(companionProductId) : null;

    // The history mandate must cover the pair, and must allow both categories,
    // or the firewall would (correctly) block the very history it is seeding.
    const pairRupees = paiseToRupees(anchor.pricePaise + (companion?.pricePaise ?? 0));
    const historyCategories = [
      ...new Set<Category>([
        anchor.category,
        ...(companion !== null ? [companion.category] : []),
        ...plan.allowedCategories,
      ]),
    ];
    const historyMaxRupees = Math.max(plan.maxAmountRupees, Math.ceil(pairRupees * 1.1));

    let orders = 0;
    const historyConfig = { ...this.ctx.config, paymentProvider: 'mock' as const };
    for (const day of HISTORY_SHAPE) {
      const when = new Date(this.ctx.clock.now().getTime() - day.daysAgo * 86_400_000);
      when.setUTCHours(10, 0, 0, 0);
      const clock = new FixedClock(when);
      const services = buildServiceContext(this.handle, clock, historyConfig);
      const gateway = new ProtocolGateway(services);
      const mandate = services.mandates.createMandate(
        {
          userId: ACTOR_IDS.userId,
          intent: plan.intent,
          maxAmountRupees: historyMaxRupees,
          allowedCategories: historyCategories,
          allowUpsell: true,
          ttlHours: 24,
        },
        ACTOR_IDS.userId,
      );
      for (const withCompanion of day.pairs) {
        const items = [{ productId: anchor.id, quantity: 1 }];
        if (withCompanion && companion !== null) {
          items.push({ productId: companion.id, quantity: 1 });
        }
        const creation = await gateway.submitPayload(
          { type: 'cart.create', items },
          { agentId: HISTORY_AGENT_ID, mandateId: mandate.row.id, protocol: 'INTERNAL' },
          { execute: true },
        );
        if (creation.decision !== 'ALLOW' || !creation.executed) {
          throw new Error(
            `History bootstrap failed at cart.create: ${creation.reason ?? creation.error?.message ?? 'unknown'}`,
          );
        }
        const cart = creation.data as CartDTO;
        const paymentResult = await gateway.submitPayload(
          { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
          { agentId: HISTORY_AGENT_ID, mandateId: mandate.row.id, protocol: 'INTERNAL' },
          { execute: true },
        );
        if (paymentResult.decision !== 'ALLOW' || !paymentResult.executed) {
          throw new Error(
            `History bootstrap failed at payment.create: ${paymentResult.reason ?? paymentResult.error?.message ?? 'unknown'}`,
          );
        }
        const payment = paymentResult.data as PaymentDTO;
        if (payment.state !== 'CAPTURED') {
          throw new Error(`History bootstrap payment ended ${payment.state}; expected CAPTURED.`);
        }
        orders += 1;
        clock.advanceMinutes(23);
      }
    }
    return {
      orders,
      revenuePaise: this.ctx.payments.getRevenueCapturedPaise(),
      anchorName: anchor.name,
    };
  }
}
