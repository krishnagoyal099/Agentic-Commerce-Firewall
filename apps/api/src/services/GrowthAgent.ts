// apps/api/src/services/GrowthAgent.ts
import { eq } from 'drizzle-orm';
import {
  ACTOR_IDS,
  formatINR,
  type CartDTO,
  type GrowthAgentReport,
  type GrowthOpportunityDTO,
  type GrowthOpportunityStatus,
  type GrowthStats,
} from '@acsf/shared';
import type { ServiceContext } from '../context';
import type { ProtocolGateway } from '../protocol/ProtocolGateway';
import * as schema from '../db/schema';
import { sha256JSON } from '../utils/hash';
import { newId } from '../utils/ids';
import { GrowthAnalyticsService } from './GrowthAnalytics';

type GrowthOpportunityRow = typeof schema.growthOpportunities.$inferSelect;

function rowToDTO(row: GrowthOpportunityRow): GrowthOpportunityDTO {
  return {
    id: row.id,
    type: row.type,
    productId: row.productId,
    anchorProductId: row.anchorProductId,
    amountPaise: row.amountPaise,
    reason: row.reason,
    confidence: row.confidence,
    stats: row.stats ?? null,
    status: row.status,
    decision: row.decision ?? null,
    decisionId: row.decisionId ?? null,
    proposedBy: row.proposedBy,
    createdAt: row.createdAt,
  };
}

export interface GrowthProposeInput {
  mandateId: string;
  cartId: string | null;
}

/**
 * Deterministic revenue-growth agent (§30). It analyzes stored transaction
 * data, persists a growth opportunity, and submits an upsell proposal through
 * the firewall. It has NO direct path to carts, payments, or the provider —
 * every effect it produces flows through ProtocolGateway →
 * AuthorizationEngine, exactly like every other agent.
 */
export class GrowthAgent {
  private readonly analyticsService: GrowthAnalyticsService;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly gateway: ProtocolGateway,
  ) {
    this.analyticsService = new GrowthAnalyticsService(ctx);
  }

  analytics(): GrowthStats[] {
    return this.analyticsService.compute();
  }

  listOpportunities(): GrowthOpportunityDTO[] {
    return this.ctx.db
      .select()
      .from(schema.growthOpportunities)
      .orderBy(schema.growthOpportunities.createdAt)
      .all()
      .map(rowToDTO);
  }

  getOpportunity(id: string): GrowthOpportunityDTO | null {
    const row = this.ctx.db
      .select()
      .from(schema.growthOpportunities)
      .where(eq(schema.growthOpportunities.id, id))
      .get();
    return row ? rowToDTO(row) : null;
  }

  async propose(input: GrowthProposeInput): Promise<GrowthAgentReport> {
    const top = this.analyticsService.top();
    if (top === null) {
      // Two very different situations produced the same sentence. compute()
      // also returns [] when there ARE completed orders but none of them
      // contains a second product — reachable on the normal path, since a
      // history run with no companion product generates 21 single-item orders.
      // Telling the user there is no history when there are 21 orders is a lie
      // about the one thing this tab exists to demonstrate.
      const completedOrders = this.ctx.db
        .select({ id: schema.orders.id })
        .from(schema.orders)
        .where(eq(schema.orders.status, 'completed'))
        .all().length;
      return {
        agentId: ACTOR_IDS.growthAgentId,
        opportunity: null,
        decision: null,
        reason: null,
        applied: false,
        cart: null,
        note:
          completedOrders === 0
            ? 'No completed transactions to analyze yet. Run START DEMO or RESET DEMO to generate real transaction history.'
            : `${completedOrders} completed order(s) analysed, but none contains a second product — there is no co-purchase pair to build an upsell from. Re-run with an intent whose category has a companion product.`,
      };
    }

    const nowIso = this.ctx.clock.now().toISOString();
    const opportunityId = newId('opp');
    this.ctx.db
      .insert(schema.growthOpportunities)
      .values({
        id: opportunityId,
        type: 'upsell',
        productId: top.productIdB,
        anchorProductId: top.productIdA,
        amountPaise: top.avgUpsellPaise,
        reason: `High co-purchase rate (${Math.round(top.coPurchaseRate * 100)}%) with ${top.productNameA}`,
        confidence: top.coPurchaseRate,
        stats: top,
        status: 'PROPOSED',
        decision: null,
        decisionId: null,
        proposedBy: ACTOR_IDS.growthAgentId,
        createdAt: nowIso,
      })
      .run();
    this.ctx.audit.append({
      actor: ACTOR_IDS.growthAgentId,
      eventType: 'GROWTH_OPPORTUNITY',
      action: 'growth.proposed',
      reason: `Proposed upsell ${top.productNameB} (${formatINR(top.avgUpsellPaise)}) on anchor ${top.productNameA} — co-purchase ${Math.round(top.coPurchaseRate * 100)}%.`,
      inputHash: sha256JSON({ opportunityId, productId: top.productIdB, anchorProductId: top.productIdA }),
      payload: {
        opportunityId,
        productId: top.productIdB,
        anchorProductId: top.productIdA,
        coPurchaseRate: top.coPurchaseRate,
        marginPercent: top.marginPercent,
        avgUpsellPaise: top.avgUpsellPaise,
      },
    });

    const item = { productId: top.productIdB, quantity: 1 };
    const result =
      input.cartId !== null
        ? await this.gateway.submitPayload(
            { type: 'upsell.create', cartId: input.cartId, items: [item] },
            { agentId: ACTOR_IDS.growthAgentId, mandateId: input.mandateId, protocol: 'INTERNAL' },
            { execute: true },
          )
        : await this.gateway.submitPayload(
            { type: 'cart.create', items: [item] },
            { agentId: ACTOR_IDS.growthAgentId, mandateId: input.mandateId, protocol: 'INTERNAL' },
            { execute: false },
          );

    const status: GrowthOpportunityStatus =
      result.decision === 'ALLOW' ? 'ALLOWED' : result.decision === 'BLOCK' ? 'BLOCKED' : 'PROPOSED';
    this.ctx.db
      .update(schema.growthOpportunities)
      .set({ status, decision: result.decision, decisionId: result.decisionId })
      .where(eq(schema.growthOpportunities.id, opportunityId))
      .run();
    this.ctx.audit.append({
      actor: 'firewall',
      eventType: 'GROWTH_OPPORTUNITY',
      action: `growth.${status.toLowerCase()}`,
      decision: result.decision,
      reason: result.reason ?? 'Firewall evaluated the growth proposal.',
      inputHash: sha256JSON({ opportunityId, decisionId: result.decisionId }),
      payload: { opportunityId, decision: result.decision, decisionId: result.decisionId, applied: result.executed },
    });

    return {
      agentId: ACTOR_IDS.growthAgentId,
      opportunity: this.getOpportunity(opportunityId),
      decision: result.decision,
      reason: result.reason,
      applied: result.executed,
      cart:
        typeof result.data === 'object' && result.data !== null && 'id' in result.data
          ? (result.data as CartDTO)
          : null,
      note: result.executed
        ? `Campaign approved: ${top.productNameB} added to the cart — co-purchase ${Math.round(top.coPurchaseRate * 100)}%, margin ${top.marginPercent}%.`
        : 'Proposal evaluated by the firewall; the growth agent never touches payment directly.',
    };
  }

  markConverted(opportunityId: string): void {
    const row = this.ctx.db
      .select()
      .from(schema.growthOpportunities)
      .where(eq(schema.growthOpportunities.id, opportunityId))
      .get();
    if (row === undefined || row.status === 'CONVERTED') return;
    this.ctx.db
      .update(schema.growthOpportunities)
      .set({ status: 'CONVERTED' })
      .where(eq(schema.growthOpportunities.id, opportunityId))
      .run();
    this.ctx.audit.append({
      actor: 'payment-service',
      eventType: 'GROWTH_OPPORTUNITY',
      action: 'growth.converted',
      reason: `Upsell ${row.productId} converted: the opportunity product was purchased.`,
      inputHash: sha256JSON({ opportunityId }),
      payload: { opportunityId, productId: row.productId },
    });
  }
}