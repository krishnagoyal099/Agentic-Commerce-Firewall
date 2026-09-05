// apps/api/src/services/BuyerAgent.ts
import { eq } from 'drizzle-orm';
import {
  ACTOR_IDS,
  formatINR,
  type BuyerPurchaseReport,
  type BuyerRunReport,
  type BuyerStep,
  type CartDTO,
  type OrderDTO,
  type ProductDTO,
} from '@acsf/shared';
import type { ServiceContext } from '../context';
import type { ProtocolGateway } from '../protocol/ProtocolGateway';
import * as schema from '../db/schema';
import { toOrderDTO } from '../utils/dto';

const STOPWORDS: ReadonlySet<string> = new Set([
  'i', 'need', 'for', 'under', 'over', 'below', 'above', 'my', 'the', 'a', 'an',
  'to', 'and', 'with', 'of', 'in', 'on', 'at', 'some', 'get',
]);

export function intentTokens(intent: string): string[] {
  return intent
    .toLowerCase()
    .replace(/[₹,]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token) && !/\d/.test(token));
}

/**
 * Deterministic buyer-agent simulation (§32). It discovers, selects, creates
 * carts, proposes, and pays — but contains NO authorization logic: it obeys
 * firewall decisions returned by the gateway and proceeds only on ALLOW.
 */
export class BuyerAgent {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly gateway: ProtocolGateway,
    private readonly agentId: string = ACTOR_IDS.buyerAgentId,
  ) {}

  async run(mandateId: string): Promise<BuyerRunReport> {
    const steps: BuyerStep[] = [];
    const mandate = this.ctx.mandates.getMandate(mandateId);
    if (mandate === null) {
      return this.runReport(mandateId, '', [], [], null, null, steps, 'MANDATE_NOT_FOUND');
    }
    if (mandate.effectiveStatus !== 'active') {
      return this.runReport(
        mandateId,
        mandate.row.intent,
        [],
        [],
        null,
        null,
        steps,
        `MANDATE_${mandate.effectiveStatus.toUpperCase()}`,
      );
    }

    const tokens = intentTokens(mandate.row.intent);
    const query = tokens.join(' ').slice(0, 200);

    // 1. Discover the catalog.
    const discovery = await this.gateway.submitPayload(
      { type: 'catalog.read', query },
      { agentId: this.agentId, mandateId, protocol: 'INTERNAL' },
      { execute: false },
    );
    const products = this.productsOf(discovery.data);
    steps.push({
      n: 1,
      title: 'Buyer agent discovers the catalog',
      tool: 'search_products',
      summary: `Searched "${query}" — ${products.length} matching product(s).`,
      decision: discovery.decision,
      detail: {
        query,
        tokens,
        matches: products.map((p) => ({ id: p.id, name: p.name, pricePaise: p.pricePaise })),
      },
    });

    // 2. Deterministically select the core product (best token score within
    //    allowed categories; ties → lower price → id order).
    const core = this.selectCore(products, mandate.row.allowedCategories, tokens);
    if (core === null) {
      steps.push({
        n: 2,
        title: 'Buyer agent selects a product',
        tool: 'select',
        summary: 'No allowed-category product matched the intent.',
        decision: null,
        detail: null,
      });
      return this.runReport(
        mandateId,
        query,
        tokens,
        products.map((p) => this.discoveredOf(p)),
        null,
        null,
        steps,
        'NO_CORE_PRODUCT',
      );
    }
    steps.push({
      n: 2,
      title: 'Buyer agent selects the core product',
      tool: 'select',
      summary: `Selected ${core.name} (${formatINR(core.pricePaise)}) — best intent match within the mandate's allowed categories.`,
      decision: null,
      detail: { productId: core.id, pricePaise: core.pricePaise, category: core.category },
    });

    // 3. Create the cart.
    const creation = await this.gateway.submitPayload(
      { type: 'cart.create', items: [{ productId: core.id, quantity: 1 }] },
      { agentId: this.agentId, mandateId, protocol: 'INTERNAL' },
      { execute: true },
    );
    const cart = this.cartOf(creation.data);
    steps.push({
      n: 3,
      title: 'Buyer agent creates a cart',
      tool: 'create_cart',
      summary:
        cart !== null
          ? `Cart ${cart.id} created — ${cart.lines.length} line(s), subtotal ${formatINR(cart.subtotalPaise)}.`
          : `Cart creation returned ${creation.decision ?? 'ERROR'}: ${creation.reason ?? creation.error?.message ?? ''}`,
      decision: creation.decision,
      detail: cart === null ? null : { cartId: cart.id, subtotalPaise: cart.subtotalPaise },
    });

    const finalState =
      cart !== null && creation.executed ? 'CART_CREATED' : `CART_${creation.decision ?? 'ERROR'}`;
    return this.runReport(
      mandateId,
      query,
      tokens,
      products.map((p) => this.discoveredOf(p)),
      { id: core.id, name: core.name, pricePaise: core.pricePaise },
      cart?.id ?? null,
      steps,
      finalState,
    );
  }

  async purchase(mandateId: string, cartId: string): Promise<BuyerPurchaseReport> {
    const steps: BuyerStep[] = [];
    const view = this.ctx.carts.getCart(cartId);
    if (view === null) {
      return {
        agentId: this.agentId,
        mandateId,
        cartId,
        decisionId: null,
        payment: null,
        order: null,
        steps,
        finalState: 'CART_NOT_FOUND',
      };
    }

    // 4. Propose the purchase — the firewall decides; nothing is charged yet.
    const proposal = await this.gateway.submitPayload(
      { type: 'payment.create', cartId, amountPaise: view.totalPaise, discountPaise: 0 },
      { agentId: this.agentId, mandateId, protocol: 'INTERNAL' },
      { execute: false },
    );
    steps.push({
      n: 1,
      title: 'Buyer agent proposes the purchase',
      tool: 'propose_purchase',
      summary: `Proposed ${formatINR(view.totalPaise)} (discount ₹0). Firewall: ${proposal.decision ?? 'ERROR'}.`,
      decision: proposal.decision,
      detail: { amountPaise: view.totalPaise, reason: proposal.reason },
    });
    if (proposal.decision !== 'ALLOW' || proposal.decisionId === null) {
      return {
        agentId: this.agentId,
        mandateId,
        cartId,
        decisionId: proposal.decisionId,
        payment: null,
        order: null,
        steps,
        finalState: `PROPOSAL_${proposal.decision ?? 'ERROR'}`,
      };
    }

    // 5. Execute the authorized payment — executePayment re-verifies the full
    //    §59 invariant chain before any provider call.
    const payment = await this.ctx.payments.executePayment(proposal.decisionId);
    steps.push({
      n: 2,
      title: 'Buyer agent requests payment execution',
      tool: 'create_payment',
      summary: `Payment ${payment.id} — ${payment.state}${payment.orderId !== null ? `, order ${payment.orderId}` : ''}.`,
      decision: 'ALLOW',
      detail: { paymentId: payment.id, state: payment.state, amountPaise: payment.amountPaise },
    });

    const orderRow =
      payment.orderId !== null
        ? this.ctx.db.select().from(schema.orders).where(eq(schema.orders.id, payment.orderId)).get()
        : undefined;
    const order: OrderDTO | null = orderRow !== undefined ? toOrderDTO(orderRow) : null;
    steps.push({
      n: 3,
      title: 'Order completes',
      tool: 'order',
      summary: order !== null ? `Order ${order.id} ${order.status} — ${formatINR(order.totalPaise)}.` : 'Order pending.',
      decision: null,
      detail: order === null ? null : { orderId: order.id, status: order.status },
    });

    const finalState =
      payment.state === 'CAPTURED' && order?.status === 'completed'
        ? 'ORDER_COMPLETED'
        : `PAYMENT_${payment.state}`;
    return {
      agentId: this.agentId,
      mandateId,
      cartId,
      decisionId: proposal.decisionId,
      payment,
      order,
      steps,
      finalState,
    };
  }

  // ---------- deterministic selection ----------

  private selectCore(products: ProductDTO[], allowedCategories: string[], tokens: string[]): ProductDTO | null {
    const candidates = products.filter((p) => p.active && allowedCategories.includes(p.category));
    if (candidates.length === 0) return null;
    const score = (p: ProductDTO): number => {
      const name = p.name.toLowerCase();
      return tokens.filter((token) => name.includes(token)).length;
    };
    return (
      [...candidates].sort(
        (a, b) => score(b) - score(a) || a.pricePaise - b.pricePaise || a.id.localeCompare(b.id),
      )[0] ?? null
    );
  }

  private discoveredOf(p: ProductDTO): { id: string; name: string; pricePaise: number; category: string } {
    return { id: p.id, name: p.name, pricePaise: p.pricePaise, category: p.category };
  }

  private runReport(
    mandateId: string,
    query: string,
    tokens: string[],
    discovered: BuyerRunReport['discovered'],
    selected: BuyerRunReport['selected'],
    cartId: string | null,
    steps: BuyerStep[],
    finalState: string,
  ): BuyerRunReport {
    return { agentId: this.agentId, mandateId, query, tokens, discovered, selected, cartId, steps, finalState };
  }

  private productsOf(data: unknown): ProductDTO[] {
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const products = (data as { products?: unknown }).products;
      if (Array.isArray(products)) {
        return products.filter((p): p is ProductDTO => typeof p === 'object' && p !== null);
      }
    }
    return [];
  }

  private cartOf(data: unknown): CartDTO | null {
    if (typeof data === 'object' && data !== null && 'id' in data && 'lines' in data) {
      return data as CartDTO;
    }
    return null;
  }
}