// packages/shared/src/states.ts
/**
 * Lifecycle state unions for persisted entities. These are the *only*
 * legal values for each column; the database schema types them via $type<>().
 */
export const CART_STATES = ['open', 'authorized', 'paid', 'stale'] as const;
export type CartState = (typeof CART_STATES)[number];

export const CART_ITEM_SOURCES = ['buyer', 'growth', 'attack', 'fuzz', 'history'] as const;
export type CartItemSource = (typeof CART_ITEM_SOURCES)[number];

export const ORDER_STATUSES = ['pending', 'completed', 'failed'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const MANDATE_STATUSES = ['active', 'superseded', 'expired'] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

export const AGENT_TYPES = ['buyer', 'growth', 'adversarial', 'history'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const HUMAN_APPROVAL_OUTCOMES = ['approved', 'rejected'] as const;
export type HumanApprovalOutcome = (typeof HUMAN_APPROVAL_OUTCOMES)[number];
