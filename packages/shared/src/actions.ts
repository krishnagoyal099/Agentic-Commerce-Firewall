// packages/shared/src/actions.ts  (MODIFIED — options, modify-with-discount, limits)
/**
 * Action model (§20) — discriminated union with enough structured information
 * for fully deterministic evaluation. Prices supplied by agents are *claims*;
 * the engine always re-resolves prices from the trusted catalog.
 */
import { formatINR } from './money';
import type { ProtocolName } from './protocol';

export const ACTION_TYPES = [
  'catalog.read',
  'cart.create',
  'cart.add_item',
  'cart.modify',
  'upsell.create',
  'payment.create',
  'payment.query',
  'payment.reconcile',
  'refund.create',
  'policy.modify',
  'mandate.modify',
  'merchant.payout.modify',
  'settlement_account.modify',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** §25 "relevant options" — structural limits enforced on every cart item. */
/**
 * Maximum quantity on a single cart line. Enforced at proposal time by
 * CatalogService.resolveItems AND on the merged total by the engine, because
 * adding items sums into an existing line.
 */
export const CART_ITEM_MAX_QUANTITY = 99;

export const CART_ITEM_OPTION_LIMITS = {
  maxOptions: 5,
  maxKeyLength: 32,
  maxValueLength: 100,
} as const;

/** Item as proposed by an untrusted agent. claimedUnitPricePaise is optional bait for tamper detection. */
export interface CartItemSpec {
  productId: string;
  quantity: number;
  claimedUnitPricePaise?: number;
  options?: Record<string, string>;
}

export interface ActionBase {
  actionId: string;
  type: ActionType;
  agentId: string;
  mandateId: string | null;
  cartId: string | null;
  protocol: ProtocolName;
  requestedCapabilities: readonly string[];
  /** ISO-8601 timestamp asserted by the transport; engine uses the injected Clock for truth. */
  timestamp: string;
  idempotencyKey: string;
}

export interface CatalogReadAction extends ActionBase {
  type: 'catalog.read';
  query: string | null;
}
export interface CartCreateAction extends ActionBase {
  type: 'cart.create';
  items: readonly CartItemSpec[];
}
export interface CartAddItemAction extends ActionBase {
  type: 'cart.add_item';
  items: readonly CartItemSpec[];
}
export interface CartModifyAction extends ActionBase {
  type: 'cart.modify';
  /** When provided, the cart's items are REPLACED by this set. */
  items?: readonly CartItemSpec[];
  /** When provided, the cart-level discount is set to this value (paise). */
  discountPaise?: number;
  reason: string | null;
}
export interface UpsellCreateAction extends ActionBase {
  type: 'upsell.create';
  items: readonly CartItemSpec[];
  pitch: string | null;
}
export interface PaymentCreateAction extends ActionBase {
  type: 'payment.create';
  amountPaise: number;
  discountPaise: number;
  orderId: string | null;
}
export interface PaymentQueryAction extends ActionBase {
  type: 'payment.query';
  paymentId: string;
}
export interface PaymentReconcileAction extends ActionBase {
  type: 'payment.reconcile';
  paymentId: string;
}
export interface RefundCreateAction extends ActionBase {
  type: 'refund.create';
  paymentId: string;
  amountPaise: number;
}
export interface PolicyModifyAction extends ActionBase {
  type: 'policy.modify';
  policyPatch: Record<string, unknown>;
}
export interface MandateModifyAction extends ActionBase {
  type: 'mandate.modify';
  mandatePatch: Record<string, unknown>;
}
export interface MerchantPayoutModifyAction extends ActionBase {
  type: 'merchant.payout.modify';
  details: Record<string, unknown>;
}
export interface SettlementAccountModifyAction extends ActionBase {
  type: 'settlement_account.modify';
  details: Record<string, unknown>;
}

export type AgentAction =
  | CatalogReadAction
  | CartCreateAction
  | CartAddItemAction
  | CartModifyAction
  | UpsellCreateAction
  | PaymentCreateAction
  | PaymentQueryAction
  | PaymentReconcileAction
  | RefundCreateAction
  | PolicyModifyAction
  | MandateModifyAction
  | MerchantPayoutModifyAction
  | SettlementAccountModifyAction;

/** Every action type maps to exactly one capability it requires. */
export function capabilityForAction(type: ActionType): string {
  switch (type) {
    case 'catalog.read':
      return 'catalog.read';
    case 'cart.create':
      return 'cart.create';
    case 'cart.add_item':
    case 'cart.modify':
      return 'cart.modify';
    case 'upsell.create':
      return 'upsell.create';
    case 'payment.create':
    case 'payment.query':
    case 'payment.reconcile':
      return 'payment.create';
    case 'refund.create':
      return 'refund.create';
    case 'policy.modify':
      return 'policy.modify';
    case 'mandate.modify':
      return 'mandate.modify';
    case 'merchant.payout.modify':
      return 'merchant.payout.modify';
    case 'settlement_account.modify':
      return 'settlement_account.modify';
  }
}

export function actionSummary(action: AgentAction): string {
  switch (action.type) {
    case 'catalog.read':
      return action.query ? `Search catalog: "${action.query}"` : 'Browse catalog';
    case 'cart.create':
      return `Create cart (${action.items.length} item${action.items.length === 1 ? '' : 's'})`;
    case 'cart.add_item':
      return `Add ${action.items.length} item${action.items.length === 1 ? '' : 's'} to cart`;
    case 'cart.modify': {
      const parts: string[] = [];
      if (action.items !== undefined) {
        parts.push(`replace items (${action.items.length})`);
      }
      if (action.discountPaise !== undefined) {
        parts.push(`apply discount ${formatINR(action.discountPaise)}`);
      }
      if (action.reason !== null) {
        parts.push(action.reason);
      }
      return `Modify cart${parts.length > 0 ? ` — ${parts.join(', ')}` : ''}`;
    }
    case 'upsell.create':
      return `Propose upsell (${action.items.length} item${action.items.length === 1 ? '' : 's'})${action.pitch ? `: ${action.pitch}` : ''}`;
    case 'payment.create':
      return `Create payment (amount ${formatINR(action.amountPaise)}, discount ${formatINR(action.discountPaise)})`;
    case 'payment.query':
      return `Query payment ${action.paymentId}`;
    case 'payment.reconcile':
      return `Reconcile payment ${action.paymentId}`;
    case 'refund.create':
      return `Create refund on payment ${action.paymentId}`;
    case 'policy.modify':
      return 'Modify merchant policy';
    case 'mandate.modify':
      return 'Modify user mandate';
    case 'merchant.payout.modify':
      return 'Modify merchant payout';
    case 'settlement_account.modify':
      return 'Modify settlement account';
  }
}