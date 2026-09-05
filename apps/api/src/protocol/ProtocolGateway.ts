// apps/api/src/protocol/ProtocolGateway.ts
/**
 * THE protocol boundary (§3–§5, §36). Every ingress — REST routes, the MCP
 * adapter, agents, attacks, the protocol demo — submits actions here:
 *
 *   payload → validated AgentAction → AuthorizationEngine → decision
 *           → (only if ALLOW) execution via domain services → payment.
 *
 * The gateway itself holds NO policy logic; it persists protocol_requests and
 * orchestrates. There is no path from any protocol to a PaymentProvider that
 * does not pass through evaluateAction() + executePayment().
 */
import { desc, eq } from 'drizzle-orm';
import {
  actionSummary,
  capabilityForAction,
  type AgentAction,
  type CartItemSource,
  type Decision,
  type DecisionReceipt,
  type DriftBreakdown,
  type ProtocolName,
  type ProtocolRequestDTO,
  type RuleViolation,
} from '@acsf/shared';
import type { PaymentPlan } from '../services/AuthorizationEngine';
import type { ActionPayload } from '../schemas';
import { buildAgentAction } from '../schemas';
import type { ServiceContext } from '../context';
import * as schema from '../db/schema';
import { DomainError } from '../utils/errors';
import { newId } from '../utils/ids';
import { toCartDTO, toProtocolRequestDTO } from '../utils/dto';
import type { AuthorizationResult } from '../services/AuthorizationEngine';

export interface GatewayResult {
  protocolRequestId: string;
  tool: string;
  status: 'ACCEPTED' | 'DENIED' | 'ERROR';
  decision: Decision | null;
  decisionId: string | null;
  reason: string | null;
  violations: RuleViolation[];
  drift: DriftBreakdown | null;
  receipt: DecisionReceipt | null;
  paymentPlan: PaymentPlan | null;
  executed: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
}

export interface SubmitPayloadContext {
  agentId: string;
  mandateId: string | null;
  protocol: ProtocolName;
  requestedCapabilities?: readonly string[];
  idempotencyKey?: string;
}

const TOOL_FOR_ACTION: Record<string, string> = {
  'catalog.read': 'search_products',
  'cart.create': 'create_cart',
  'cart.add_item': 'add_cart_item',
  'cart.modify': 'modify_cart',
  'upsell.create': 'propose_upsell',
  'payment.create': 'create_payment',
  'payment.query': 'get_payment_status',
  'payment.reconcile': 'reconcile_payment',
  'refund.create': 'refund',
  'policy.modify': 'modify_policy',
  'mandate.modify': 'modify_mandate',
  'merchant.payout.modify': 'merchant_payout',
  'settlement_account.modify': 'settlement_account',
};

export class ProtocolGateway {
  constructor(private readonly ctx: ServiceContext) {}

  /** Payload-level submission: builds the typed action server-side, then submits. */
  async submitPayload(
    payload: ActionPayload,
    context: SubmitPayloadContext,
    options: { execute: boolean },
  ): Promise<GatewayResult> {
    const action = buildAgentAction(payload, {
      agentId: context.agentId,
      mandateId: context.mandateId,
      protocol: context.protocol,
      requestedCapabilities: context.requestedCapabilities ?? [capabilityForAction(payload.type)],
      actionId: newId('act'),
      idempotencyKey: context.idempotencyKey ?? newId('idem'),
      timestamp: this.ctx.clock.now().toISOString(),
    });
    return this.submit(action, options);
  }

  /** Action-level submission (used by agents, attacks, and the fuzzer). */
  async submit(action: AgentAction, options: { execute: boolean }): Promise<GatewayResult> {
    const tool = TOOL_FOR_ACTION[action.type] ?? action.type;
    const rowId = newId('preq');
    this.ctx.db
      .insert(schema.protocolRequests)
      .values({
        id: rowId,
        requestId: rowId,
        protocol: action.protocol,
        tool,
        agentId: action.agentId,
        status: 'ACCEPTED',
        decision: null,
        decisionId: null,
        summary: actionSummary(action),
        createdAt: this.ctx.clock.now().toISOString(),
      })
      .run();

    let evaluation: AuthorizationResult;
    try {
      evaluation = this.ctx.authorization.evaluateAction(action);
    } catch (err) {
      if (err instanceof DomainError) {
        this.updateProtocolRequest(rowId, {
          status: 'ERROR',
          summary: `${actionSummary(action)} — ${err.code}`,
        });
        return this.result(rowId, tool, 'ERROR', null, false, null, { code: err.code, message: err.message });
      }
      throw err;
    }

    // Only an ALLOW is an accepted request. This row used to be written as
    // ACCEPTED for every evaluated action, so /api/protocol/status reported
    // totals.denied = 0 however many attacks the firewall had just blocked,
    // and the persisted row contradicted the DENIED the MCP adapter returned
    // to the caller for the very same request.
    const accepted = evaluation.decision === 'ALLOW';
    this.updateProtocolRequest(rowId, {
      status: accepted ? 'ACCEPTED' : 'DENIED',
      decision: evaluation.decision,
      decisionId: evaluation.decisionId,
    });

    let executed = false;
    // Read payloads are an effect of the decision, not a freebie that precedes
    // it. Computing this unconditionally returned the catalog — and a full
    // PaymentDTO with amount, provider id and state timeline — alongside a
    // BLOCK verdict, to an agent the engine had just refused.
    let data: unknown = accepted ? this.readOnlyData(action) : null;
    let status: 'ACCEPTED' | 'DENIED' | 'ERROR' = accepted ? 'ACCEPTED' : 'DENIED';
    let error: { code: string; message: string } | null = null;

    if (options.execute && evaluation.decision === 'ALLOW') {
      try {
        data = await this.applyEffects(action, evaluation);
        executed = true;
      } catch (err) {
        if (err instanceof DomainError) {
          status = 'ERROR';
          error = { code: err.code, message: err.message };
          this.updateProtocolRequest(rowId, {
            status: 'ERROR',
            summary: `${actionSummary(action)} — execution failed: ${err.code}`,
          });
        } else {
          throw err;
        }
      }
    }

    return this.result(rowId, tool, status, evaluation, executed, data, error);
  }

  /** Read-only protocol activity logging (get_cart, receipt reads, status checks). */
  note(tool: string, agentId: string, summary: string): ProtocolRequestDTO {
    return this.insertProtocolRequest(tool, agentId, 'ACCEPTED', summary, null, null);
  }

  /** Protocol-boundary denial for unknown/privileged tools (§39). */
  noteDeniedTool(tool: string, agentId: string, summary: string): ProtocolRequestDTO {
    return this.insertProtocolRequest(tool, agentId, 'DENIED', summary, null, null);
  }

  listProtocolRequests(limit = 50): ProtocolRequestDTO[] {
    const bounded = Math.min(Math.max(limit, 1), 200);
    return this.ctx.db
      .select()
      .from(schema.protocolRequests)
      .orderBy(desc(schema.protocolRequests.createdAt))
      .limit(bounded)
      .all()
      .map(toProtocolRequestDTO);
  }

  protocolTotals(): { accepted: number; denied: number; error: number } {
    const rows = this.ctx.db
      .select({ status: schema.protocolRequests.status })
      .from(schema.protocolRequests)
      .all();
    const totals = { accepted: 0, denied: 0, error: 0 };
    for (const row of rows) {
      if (row.status === 'ACCEPTED') totals.accepted += 1;
      else if (row.status === 'DENIED') totals.denied += 1;
      else totals.error += 1;
    }
    return totals;
  }

  // ---------- private ----------

  private async applyEffects(action: AgentAction, evaluation: AuthorizationResult): Promise<unknown> {
    const source = this.sourceForAgent(action.agentId);
    switch (action.type) {
      case 'cart.create': {
        if (evaluation.itemsToApply === null || action.mandateId === null) {
          throw new DomainError('EXECUTION_INCOMPLETE', 'Cart creation plan is missing.');
        }
        const view = this.ctx.carts.createCart({
          mandateId: action.mandateId,
          agentId: action.agentId,
          protocol: action.protocol,
          items: evaluation.itemsToApply,
          source,
          decisionId: evaluation.decisionId,
        });
        this.ctx.db
          .update(schema.authorizationDecisions)
          .set({ cartId: view.cart.id })
          .where(eq(schema.authorizationDecisions.id, evaluation.decisionId))
          .run();
        return toCartDTO(view);
      }
      case 'cart.add_item':
      case 'upsell.create': {
        if (evaluation.itemsToApply === null || action.cartId === null) {
          throw new DomainError('EXECUTION_INCOMPLETE', 'Cart item plan is missing.');
        }
        const view = this.ctx.carts.addItems(action.cartId, evaluation.itemsToApply, source, evaluation.decisionId);
        return toCartDTO(view);
      }
      case 'cart.modify': {
        if (action.cartId === null) {
          throw new DomainError('EXECUTION_INCOMPLETE', 'Cart modification requires a cart.');
        }
        const plan = evaluation.modifyPlan ?? { cartId: action.cartId, items: null, discountPaise: null };
        const view = this.ctx.carts.modifyCart(
          action.cartId,
          { items: plan.items, discountPaise: plan.discountPaise },
          source,
          evaluation.decisionId,
        );
        return toCartDTO(view);
      }
      case 'payment.create':
        return await this.ctx.payments.executePayment(evaluation.decisionId);
      case 'payment.reconcile':
        return await this.ctx.reconciliation.reconcile(action.paymentId);
      default:
        return null;
    }
  }

  private readOnlyData(action: AgentAction): unknown {
    switch (action.type) {
      case 'catalog.read':
        return { products: this.ctx.catalog.searchProducts(action.query) };
      case 'payment.query':
        return this.ctx.payments.getPayment(action.paymentId);
      default:
        return null;
    }
  }

  private sourceForAgent(agentId: string): CartItemSource {
    const agent = this.ctx.capabilities.getAgent(agentId);
    switch (agent?.agentType) {
      case 'growth':
        return 'growth';
      case 'adversarial':
        return 'attack';
      case 'history':
        return 'history';
      default:
        return 'buyer';
    }
  }

  private result(
    rowId: string,
    tool: string,
    status: 'ACCEPTED' | 'DENIED' | 'ERROR',
    evaluation: AuthorizationResult | null,
    executed: boolean,
    data: unknown,
    error: { code: string; message: string } | null,
  ): GatewayResult {
    return {
      protocolRequestId: rowId,
      tool,
      status,
      decision: evaluation?.decision ?? null,
      decisionId: evaluation?.decisionId ?? null,
      reason: evaluation?.reason ?? null,
      violations: evaluation?.violations ?? [],
      drift: evaluation?.drift ?? null,
      receipt: evaluation?.receipt ?? null,
      paymentPlan: evaluation?.paymentPlan ?? null,
      executed,
      data,
      error,
    };
  }

  private updateProtocolRequest(
    rowId: string,
    patch: { status?: 'ACCEPTED' | 'DENIED' | 'ERROR'; decision?: Decision | null; decisionId?: string | null; summary?: string },
  ): void {
    this.ctx.db
      .update(schema.protocolRequests)
      .set(patch)
      .where(eq(schema.protocolRequests.id, rowId))
      .run();
  }

  private insertProtocolRequest(
    tool: string,
    agentId: string,
    status: 'ACCEPTED' | 'DENIED',
    summary: string,
    decision: Decision | null,
    decisionId: string | null,
  ): ProtocolRequestDTO {
    const rowId = newId('preq');
    this.ctx.db
      .insert(schema.protocolRequests)
      .values({
        id: rowId,
        requestId: rowId,
        protocol: 'MCP',
        tool,
        agentId,
        status,
        decision,
        decisionId,
        summary,
        createdAt: this.ctx.clock.now().toISOString(),
      })
      .run();
    const row = this.ctx.db
      .select()
      .from(schema.protocolRequests)
      .where(eq(schema.protocolRequests.id, rowId))
      .get();
    if (!row) throw new DomainError('PROTOCOL_REQUEST_NOT_FOUND', 'Protocol request missing after insert.');
    return toProtocolRequestDTO(row);
  }
}
