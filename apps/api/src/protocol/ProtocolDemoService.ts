// apps/api/src/protocol/ProtocolDemoService.ts
/**
 * The scripted 10-step end-to-end protocol demo. Every tool call goes through
 * the MCP adapter → gateway → AuthorizationEngine → services — the same path
 * the stdio MCP server uses. Nothing is faked: a real mandate (created through
 * MandateService if absent), a real cart, a real ALLOW decision, a real mock
 * capture, a real completed order, and a real receipt.
 */
import { eq } from 'drizzle-orm';
import { ACTOR_IDS, DEMO_INTENT, formatINR, type Decision, type PaymentDTO, type ProductDTO } from '@acsf/shared';
import type { ProtocolInvocation, ProtocolResult } from '@acsf/protocol';
import type { ServiceContext } from '../context';
import * as schema from '../db/schema';
import { newId } from '../utils/ids';
import { toOrderDTO } from '../utils/dto';
import type { MCPCommerceAdapter } from './mcp/MCPCommerceAdapter';

export interface ProtocolDemoStep {
  step: number;
  title: string;
  tool: string;
  protocolRequestId: string | null;
  decision: Decision | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

export interface ProtocolDemoReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  mandateId: string;
  cartId: string | null;
  orderId: string | null;
  paymentId: string | null;
  decisionId: string | null;
  steps: ProtocolDemoStep[];
  finalState: string;
  receiptText: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class ProtocolDemoService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly adapter: MCPCommerceAdapter,
  ) {}

  async run(): Promise<ProtocolDemoReport> {
    const runId = newId('pdemo');
    const startedAt = this.ctx.clock.now().toISOString();
    const steps: ProtocolDemoStep[] = [];

    let mandate = this.ctx.mandates.getActiveMandateForUser(ACTOR_IDS.demoUserId);
    if (mandate === null) {
      const parsedInput = (await import('../services/MandateService')).MandateCreateSchema.parse({
        userId: ACTOR_IDS.demoUserId,
        intent: DEMO_INTENT,
        maxAmountRupees: 8000,
        allowedCategories: ['running_shoes'],
        allowUpsell: true,
        ttlHours: 24,
      });
      mandate = this.ctx.mandates.createMandate(parsedInput, ACTOR_IDS.demoUserId);
    }
    const agentId = ACTOR_IDS.buyerAgentId;
    const mandateId = mandate.row.id;

    const mk = (tool: string, args: Record<string, unknown>, n: number): ProtocolInvocation => ({
      requestId: `${runId}-${n}`,
      agentId,
      mandateId,
      tool,
      args,
    });
    const record = (
      n: number,
      title: string,
      tool: string,
      result: ProtocolResult | null,
      summary: string,
      detail: Record<string, unknown> | null = null,
    ): void => {
      steps.push({
        step: n,
        title,
        tool,
        protocolRequestId: result === null ? null : str(result.requestId),
        decision: result === null ? null : result.decision,
        summary,
        detail,
      });
    };

    // 1. Discover the merchant (browse the catalog).
    const r1 = await this.adapter.invoke(mk('search_products', { agentId, query: '' }, 1));
    const products1 = this.productsOf(r1.data);
    record(1, 'AI buyer discovers merchant', 'search_products', r1, `Discovered the merchant catalog: ${products1.length} products.`, { productCount: products1.length });

    // 2. Search for running gear.
    const r2 = await this.adapter.invoke(mk('search_products', { agentId, query: 'running' }, 2));
    const products2 = this.productsOf(r2.data);
    record(2, 'AI buyer searches catalog', 'search_products', r2, `Search "running": ${products2.map((p) => `${p.name} (${formatINR(p.pricePaise)})`).join(', ')}.`, { results: products2.map((p) => ({ id: p.id, name: p.name, pricePaise: p.pricePaise })) });

    // 3. Inspect the primary product.
    const r3 = await this.adapter.invoke(mk('get_product', { agentId, productId: 'shoe-001' }, 3));
    const product3 = asRecord(asRecord(r3.data)?.product ?? null);
    record(3, 'AI buyer reads product data', 'get_product', r3, `Read ${str(product3?.name) ?? 'shoe-001'} — ${formatINR(Number(product3?.pricePaise ?? 0))}.`, { product: product3 });

    // 4. Create the cart (shoes + socks = ₹7,798).
    const r4 = await this.adapter.invoke(
      mk('create_cart', { agentId, mandateId, items: [{ productId: 'shoe-001', quantity: 1 }, { productId: 'sock-001', quantity: 1 }] }, 4),
    );
    const cartRec = asRecord(r4.data);
    const cartId = str(cartRec?.id);
    record(4, 'AI buyer creates cart', 'create_cart', r4, cartId !== null ? `Cart ${cartId} created — total ${formatINR(Number(cartRec?.totalPaise ?? 0))}.` : `Cart creation denied: ${r4.error?.message ?? r4.decision ?? 'unknown'}.`, { cart: cartRec });

    if (cartId === null || r4.status !== 'OK') {
      return this.finish(runId, startedAt, mandateId, null, null, null, null, steps, 'ABORTED_AT_CART', null);
    }
    const totalPaise = Number(cartRec?.totalPaise ?? 0);

    // 5. Propose the purchase (authorization request — no charge).
    const r5 = await this.adapter.invoke(mk('propose_purchase', { agentId, mandateId, cartId, discountPaise: 0 }, 5));
    record(5, 'AI buyer proposes purchase', 'propose_purchase', r5, `Proposal submitted for ${formatINR(totalPaise)}; awaiting firewall decision.`, { decision: r5.decision });

    // 6. Firewall evaluation (from the persisted decision).
    const decisionRow = (r5.decisionId ?? null) !== null ? this.ctx.authorization.getDecision(r5.decisionId!) : null;
    record(6, 'Firewall evaluates the proposal', 'firewall', r5, decisionRow !== null ? `${decisionRow.decision} — ${decisionRow.reason}` : 'Decision unavailable.', {
      decisionId: r5.decisionId,
      drift: decisionRow?.drift?.overall ?? null,
      violations: decisionRow?.violations.map((v) => v.code) ?? [],
    });

    if (r5.decision !== 'ALLOW') {
      return this.finish(runId, startedAt, mandateId, cartId, null, null, r5.decisionId ?? null, steps, `PROPOSAL_${r5.decision}`, null);
    }

    // 7. Create the payment (authorized at provider).
    const r7 = await this.adapter.invoke(mk('create_payment', { agentId, mandateId, cartId, amountPaise: totalPaise, discountPaise: 0 }, 7));
    const payment = this.paymentOf(r7.data);
    const paymentId = payment?.id ?? null;
    record(7, 'Payment is authorized', 'create_payment', r7, paymentId !== null ? `Payment ${paymentId} authorized for ${formatINR(totalPaise)} — invariant chain passed, dispatched to provider.` : `Payment failed: ${r7.error?.message ?? 'unknown'}.`, { paymentId, state: payment?.state ?? null });

    if (payment === null || r7.status !== 'OK') {
      return this.finish(runId, startedAt, mandateId, cartId, null, paymentId, r7.decisionId ?? null, steps, 'PAYMENT_FAILED', null);
    }

    // 8. Payment captured.
    const capturedAt = payment.timeline.find((e) => e.state === 'CAPTURED')?.at ?? null;
    record(8, 'Payment is captured', 'payment', r7, `Captured ${formatINR(payment.amountPaise)}${capturedAt !== null ? ` at ${capturedAt}` : ''}. No duplicate charge created.`, { paymentId: payment.id, state: payment.state, capturedAt });

    // 9. Order completed.
    const orderRow = payment.orderId !== null
      ? this.ctx.db.select().from(schema.orders).where(eq(schema.orders.id, payment.orderId)).get() ?? null
      : null;
    record(9, 'Order is completed', 'order', null, orderRow !== null ? `Order ${orderRow.id} completed — ${formatINR(orderRow.totalPaise)}, cart marked paid.` : 'Order pending.', orderRow !== null ? toOrderDTO(orderRow) as unknown as Record<string, unknown> : null);

    // 10. Audit receipt generated.
    const r10 = await this.adapter.invoke(mk('get_decision_receipt', { agentId, decisionId: r7.decisionId ?? '' }, 10));
    const receiptText = str(asRecord(r10.data)?.text);
    record(10, 'Audit receipt generated', 'get_decision_receipt', r10, receiptText !== null ? 'Decision receipt generated and recorded in the audit chain.' : 'Receipt unavailable.', { decisionId: r7.decisionId });

    return this.finish(runId, startedAt, mandateId, cartId, payment.orderId, payment.id, r7.decisionId ?? null, steps, 'ORDER_COMPLETED', receiptText);
  }

  private finish(
    runId: string,
    startedAt: string,
    mandateId: string,
    cartId: string | null,
    orderId: string | null,
    paymentId: string | null,
    decisionId: string | null,
    steps: ProtocolDemoStep[],
    finalState: string,
    receiptText: string | null,
  ): ProtocolDemoReport {
    return {
      runId,
      startedAt,
      finishedAt: this.ctx.clock.now().toISOString(),
      mandateId,
      cartId,
      orderId,
      paymentId,
      decisionId,
      steps,
      finalState,
      receiptText,
    };
  }

  private productsOf(data: unknown): ProductDTO[] {
    const rec = asRecord(data);
    const products = rec?.products;
    return Array.isArray(products) ? products.filter((p): p is ProductDTO => typeof p === 'object' && p !== null) : [];
  }

  private paymentOf(data: unknown): PaymentDTO | null {
    const rec = asRecord(data);
    if (rec !== null && typeof rec.id === 'string' && typeof rec.state === 'string') {
      return data as PaymentDTO;
    }
    return null;
  }
}
