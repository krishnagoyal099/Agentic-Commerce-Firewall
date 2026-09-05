// apps/api/src/services/CartService.ts  (MODIFIED — full reprint)
import { eq } from 'drizzle-orm';
import type { CartItemSource, Category, ProtocolName } from '@acsf/shared';
import type { AppDatabase } from '../db/client';
import type { AuthorizationDecisionRow, CartRow, MandateRow } from '../db/schema';
import * as schema from '../db/schema';
import { DomainError } from '../utils/errors';
import { sha256JSON } from '../utils/hash';
import { newId } from '../utils/ids';
import type { Clock } from '../utils/clock';
import type { AuditService } from './AuditService';
import type { AuthorityDriftEngine } from './AuthorityDriftEngine';
import type { CartIntegrityService } from './CartIntegrityService';
import type { ResolvedCartItem } from './CatalogService';

export interface CartLineItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPricePaise: number;
  options: Record<string, string>;
  category: Category;
  marginPercent: number;
}

export interface CartView {
  cart: CartRow;
  lines: CartLineItem[];
  subtotalPaise: number;
  totalPaise: number;
}

export interface CreateCartInput {
  mandateId: string;
  agentId: string;
  protocol: ProtocolName;
  items: readonly ResolvedCartItem[];
  source: CartItemSource;
  decisionId: string;
}

/**
 * Cart state mutations. INVARIANT: every mutating method requires a prior
 * AuthorizationEngine decision id, re-verifies it (ALLOW — or
 * HUMAN_APPROVAL that a human has since approved — matching cart and action
 * type, not already consumed), and marks it consumed. There is NO code path
 * that mutates a cart without a firewall decision.
 *
 * Cross-agent collaboration is intentional: a growth agent's ALLOWED upsell
 * decision may add items to a buyer-owned cart — the decision's cartId binding
 * is what matters, and the engine produced that decision.
 */
export class CartService {
  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly drift: AuthorityDriftEngine,
    private readonly integrity: CartIntegrityService,
  ) {}

  getCart(cartId: string): CartView | null {
    const cart = this.db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
    if (!cart) return null;
    const rows = this.db
      .select({ item: schema.cartItems, product: schema.products })
      .from(schema.cartItems)
      .innerJoin(schema.products, eq(schema.cartItems.productId, schema.products.id))
      .where(eq(schema.cartItems.cartId, cartId))
      .all();
    const lines: CartLineItem[] = rows
      .map(({ item, product }) => ({
        productId: item.productId,
        productName: product.name,
        quantity: item.quantity,
        unitPricePaise: item.unitPricePaise,
        options: item.options ?? {},
        category: product.category,
        marginPercent: product.marginPercent,
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId));
    const subtotalPaise = lines.reduce((sum, line) => sum + line.unitPricePaise * line.quantity, 0);
    return { cart, lines, subtotalPaise, totalPaise: subtotalPaise - cart.discountPaise };
  }

  private verifyDecision(
    decisionId: string,
    opts: { actionTypes: string[]; cartId: string | null },
  ): AuthorizationDecisionRow {
    const row = this.db
      .select()
      .from(schema.authorizationDecisions)
      .where(eq(schema.authorizationDecisions.id, decisionId))
      .get();
    if (!row) {
      throw new DomainError('DECISION_NOT_FOUND', `Authorization decision ${decisionId} does not exist.`);
    }
    const authorized = row.decision === 'ALLOW' || (row.decision === 'HUMAN_APPROVAL' && row.approvedAt !== null);
    if (!authorized) {
      throw new DomainError(
        'DECISION_NOT_AUTHORIZED',
        `Decision ${decisionId} is ${row.decision}${
          row.decision === 'HUMAN_APPROVAL' && row.approvedAt === null ? ' (not yet approved)' : ''
        } and does not authorize execution.`,
      );
    }
    if (row.consumedAt !== null) {
      throw new DomainError('DECISION_ALREADY_CONSUMED', `Decision ${decisionId} was already executed exactly once.`);
    }
    if (!opts.actionTypes.includes(row.actionType)) {
      throw new DomainError(
        'DECISION_ACTION_MISMATCH',
        `Decision ${decisionId} is for action type ${row.actionType}, expected one of ${opts.actionTypes.join(', ')}.`,
      );
    }
    if ((row.cartId ?? null) !== opts.cartId) {
      throw new DomainError(
        'DECISION_CART_MISMATCH',
        `Decision ${decisionId} does not apply to cart ${opts.cartId ?? '(new)'}.`,
      );
    }
    return row;
  }

  private consumeDecision(decisionId: string): void {
    this.db
      .update(schema.authorizationDecisions)
      .set({ consumedAt: this.clock.now().toISOString() })
      .where(eq(schema.authorizationDecisions.id, decisionId))
      .run();
  }

  private mandateRow(mandateId: string): MandateRow {
    const row = this.db.select().from(schema.mandates).where(eq(schema.mandates.id, mandateId)).get();
    if (!row) {
      throw new DomainError('MANDATE_NOT_FOUND', `Mandate ${mandateId} does not exist.`);
    }
    return row;
  }

  private insertLines(cartId: string, items: readonly ResolvedCartItem[], source: CartItemSource): void {
    const nowIso = this.clock.now().toISOString();
    for (const item of items) {
      this.db
        .insert(schema.cartItems)
        .values({
          id: newId('item'),
          cartId,
          productId: item.productId,
          quantity: item.quantity,
          unitPricePaise: item.unitPricePaise,
          marginPercent: item.marginPercent,
          options: item.options ?? {},
          source,
          createdAt: nowIso,
        })
        .run();
    }
  }

  createCart(input: CreateCartInput): CartView {
    const decision = this.verifyDecision(decisionIdOf(input), { actionTypes: ['cart.create'], cartId: null });
    if (decision.agentId !== input.agentId) {
      throw new DomainError(
        'DECISION_AGENT_MISMATCH',
        `Decision ${decision.id} belongs to agent ${decision.agentId}, not ${input.agentId}.`,
      );
    }
    const mandate = this.mandateRow(input.mandateId);
    const nowIso = this.clock.now().toISOString();
    const cartId = newId('cart');
    const currentHash = this.integrity.computeHash(
      input.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPricePaise: item.unitPricePaise,
        options: item.options ?? {},
      })),
      0,
    );
    this.db
      .insert(schema.carts)
      .values({
        id: cartId,
        mandateId: input.mandateId,
        agentId: input.agentId,
        state: 'open',
        discountPaise: 0,
        authorizedHash: null,
        currentHash,
        authorizationId: null,
        authorizationExpiresAt: null,
        protocol: input.protocol,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();
    this.insertLines(cartId, input.items, input.source);
    const session = this.drift.getSession(input.agentId, input.mandateId, input.protocol);
    this.drift.recordExecutedItems(session.id, input.items, mandate);
    this.audit.append({
      actor: input.agentId,
      eventType: 'CART_CREATED',
      action: 'cart.created',
      reason: `Cart created with ${input.items.length} item(s); hash ${currentHash.slice(0, 12)}…`,
      inputHash: currentHash,
      payload: {
        cartId,
        decisionId: input.decisionId,
        items: input.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      },
    });
    this.consumeDecision(input.decisionId);
    const view = this.getCart(cartId);
    if (!view) throw new DomainError('CART_NOT_FOUND', 'Cart missing after creation.');
    return view;
  }

  /** Applies an allowed cart.add_item / upsell.create decision. Modifying an AUTHORIZED cart transitions it to STALE (§25). */
  addItems(
    cartId: string,
    items: readonly ResolvedCartItem[],
    source: CartItemSource,
    decisionId: string,
  ): CartView {
    this.verifyDecision(decisionId, { actionTypes: ['cart.add_item', 'upsell.create'], cartId });
    const cart = this.getCart(cartId);
    if (!cart) throw new DomainError('CART_NOT_FOUND', `Cart ${cartId} does not exist.`);
    if (cart.cart.state === 'paid') {
      throw new DomainError('CART_IMMUTABLE', `Cart ${cartId} is paid and can no longer be modified.`);
    }
    const nowIso = this.clock.now().toISOString();
    for (const item of items) {
      const existing = this.db
        .select()
        .from(schema.cartItems)
        .where(eq(schema.cartItems.cartId, cartId))
        .all()
        .find((row) => row.productId === item.productId);
      if (existing) {
        this.db
          .update(schema.cartItems)
          .set({ quantity: existing.quantity + item.quantity })
          .where(eq(schema.cartItems.id, existing.id))
          .run();
      } else {
        this.db
          .insert(schema.cartItems)
          .values({
            id: newId('item'),
            cartId,
            productId: item.productId,
            quantity: item.quantity,
            unitPricePaise: item.unitPricePaise,
            marginPercent: item.marginPercent,
            options: item.options ?? {},
            source,
            createdAt: nowIso,
          })
          .run();
      }
    }
    this.applyStateAndHash(cartId);
    const mandate = this.mandateRow(cart.cart.mandateId);
    const session = this.drift.getSession(cart.cart.agentId, cart.cart.mandateId, cart.cart.protocol);
    this.drift.recordExecutedItems(session.id, items, mandate);
    this.audit.append({
      actor: cart.cart.agentId,
      eventType: 'AGENT_PROPOSAL',
      action: 'cart.items_applied',
      reason: `${items.length} item(s) applied from an ALLOWED decision.`,
      inputHash: sha256JSON({ cartId, items }),
      payload: {
        cartId,
        decisionId,
        source,
        items: items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      },
    });
    this.consumeDecision(decisionId);
    const view = this.getCart(cartId);
    if (!view) throw new DomainError('CART_NOT_FOUND', `Cart ${cartId} missing after update.`);
    return view;
  }

  /** Applies an allowed cart.modify decision: item replacement and/or cart discount. */
  modifyCart(
    cartId: string,
    changes: { items: readonly ResolvedCartItem[] | null; discountPaise: number | null },
    source: CartItemSource,
    decisionId: string,
  ): CartView {
    this.verifyDecision(decisionId, { actionTypes: ['cart.modify'], cartId });
    const cart = this.getCart(cartId);
    if (!cart) throw new DomainError('CART_NOT_FOUND', `Cart ${cartId} does not exist.`);
    if (cart.cart.state === 'paid') {
      throw new DomainError('CART_IMMUTABLE', `Cart ${cartId} is paid and can no longer be modified.`);
    }
    if (changes.items !== null) {
      this.db.delete(schema.cartItems).where(eq(schema.cartItems.cartId, cartId)).run();
      this.insertLines(cartId, changes.items, source);
    }
    if (changes.discountPaise !== null) {
      this.db
        .update(schema.carts)
        .set({ discountPaise: changes.discountPaise })
        .where(eq(schema.carts.id, cartId))
        .run();
    }
    this.applyStateAndHash(cartId);
    if (changes.items !== null) {
      const mandate = this.mandateRow(cart.cart.mandateId);
      const session = this.drift.getSession(cart.cart.agentId, cart.cart.mandateId, cart.cart.protocol);
      this.drift.recordExecutedItems(session.id, changes.items, mandate);
    }
    this.audit.append({
      actor: cart.cart.agentId,
      eventType: 'AGENT_PROPOSAL',
      action: 'cart.modified',
      reason: 'Cart modification applied from an ALLOWED decision.',
      inputHash: sha256JSON({
        cartId,
        changes: { itemCount: changes.items?.length ?? 0, discountPaise: changes.discountPaise },
      }),
      payload: { cartId, decisionId, source, discountPaise: changes.discountPaise },
    });
    this.consumeDecision(decisionId);
    const view = this.getCart(cartId);
    if (!view) throw new DomainError('CART_NOT_FOUND', `Cart ${cartId} missing after update.`);
    return view;
  }

  /**
   * Payment authorization (§59): stores the authorized discount, the
   * authorized cart hash, the authorizing decision, and the TTL deadline.
   * The stored authorizedHash covers items + discount — any later mutation
   * recomputes currentHash and payment execution requires equality.
   */
  applyAuthorization(
    cartId: string,
    discountPaise: number,
    decisionId: string,
    expiresAtIso: string,
  ): CartView {
    this.verifyDecision(decisionId, { actionTypes: ['payment.create'], cartId });
    const cart = this.getCart(cartId);
    if (!cart) throw new DomainError('CART_NOT_FOUND', `Cart ${cartId} does not exist.`);
    if (cart.cart.state === 'paid') {
      throw new DomainError('CART_IMMUTABLE', `Cart ${cartId} is paid and can no longer be authorized.`);
    }
    const nowIso = this.clock.now().toISOString();
    // Never lower a discount the cart already carries: this used to overwrite
    // the stored value with the payment action's own (usually 0), wiping an
    // allowed cart.modify discount off the record after the engine had already
    // priced the order with it.
    const effectiveDiscountPaise = Math.max(discountPaise, cart.cart.discountPaise);
    this.db
      .update(schema.carts)
      .set({ discountPaise: effectiveDiscountPaise, state: 'authorized', updatedAt: nowIso })
      .where(eq(schema.carts.id, cartId))
      .run();
    const authorizedHash = this.integrity.hashForCart(cartId);
    if (!authorizedHash) throw new DomainError('CART_NOT_FOUND', `Cart ${cartId} missing during authorization.`);
    this.db
      .update(schema.carts)
      .set({
        authorizedHash,
        currentHash: authorizedHash,
        authorizationId: decisionId,
        authorizationExpiresAt: expiresAtIso,
        updatedAt: nowIso,
      })
      .where(eq(schema.carts.id, cartId))
      .run();
    this.consumeDecision(decisionId);
    const view = this.getCart(cartId);
    if (!view) throw new DomainError('CART_NOT_FOUND', `Cart ${cartId} missing after authorization.`);
    return view;
  }

  /**
   * Releases a cart's payment authorization after a failed or not-found
   * payment: state returns to 'open', the authorization and discount are
   * cleared, contents remain. A fresh payment.create proposal (with a fresh
   * firewall evaluation) is required to retry.
   */
  releaseAuthorization(cartId: string): boolean {
    const cart = this.getCart(cartId);
    if (!cart) return false;
    if (cart.cart.state === 'paid') return false;
    const currentHash = this.integrity.hashForCart(cartId) ?? cart.cart.currentHash;
    this.db
      .update(schema.carts)
      .set({
        state: 'open',
        discountPaise: 0,
        authorizedHash: null,
        authorizationId: null,
        authorizationExpiresAt: null,
        currentHash,
        updatedAt: this.clock.now().toISOString(),
      })
      .where(eq(schema.carts.id, cartId))
      .run();
    return true;
  }

  markPaid(cartId: string): void {
    const nowIso = this.clock.now().toISOString();
    this.db
      .update(schema.carts)
      .set({ state: 'paid', updatedAt: nowIso })
      .where(eq(schema.carts.id, cartId))
      .run();
  }

  private applyStateAndHash(cartId: string): void {
    const cart = this.getCart(cartId);
    if (!cart) throw new DomainError('CART_NOT_FOUND', `Cart ${cartId} does not exist.`);
    const currentHash = this.integrity.hashForCart(cartId);
    if (!currentHash) throw new DomainError('CART_NOT_FOUND', `Cart ${cartId} missing during rehash.`);
    const nextState = cart.cart.state === 'authorized' ? 'stale' : cart.cart.state;
    this.db
      .update(schema.carts)
      .set({ currentHash, state: nextState, updatedAt: this.clock.now().toISOString() })
      .where(eq(schema.carts.id, cartId))
      .run();
  }
}

function decisionIdOf(input: CreateCartInput): string {
  return input.decisionId;
}