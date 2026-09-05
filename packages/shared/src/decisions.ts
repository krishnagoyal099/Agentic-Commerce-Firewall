// packages/shared/src/decisions.ts  (MODIFIED — adds CART_IMMUTABLE)
/**
 * The four — and only four — outcomes of the AuthorizationEngine.
 * Precedence (highest wins): BLOCK > REAUTHORIZE > HUMAN_APPROVAL > ALLOW.
 */
export const DECISIONS = ['ALLOW', 'HUMAN_APPROVAL', 'REAUTHORIZE', 'BLOCK'] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_SEVERITY: Record<Decision, number> = {
  ALLOW: 0,
  HUMAN_APPROVAL: 1,
  REAUTHORIZE: 2,
  BLOCK: 3,
};

export function mostSevere(a: Decision, b: Decision): Decision {
  return DECISION_SEVERITY[a] >= DECISION_SEVERITY[b] ? a : b;
}

export const DECISION_LABELS: Record<Decision, string> = {
  ALLOW: 'Allow',
  HUMAN_APPROVAL: 'Human approval required',
  REAUTHORIZE: 'Reauthorization required',
  BLOCK: 'Blocked',
};

/** Which authority boundary a rule violation belongs to. */
export type ViolationBoundary = 'security' | 'merchant' | 'user' | 'state';

export const VIOLATION_CODES = [
  // security — hard violations, always BLOCK
  'AGENT_NOT_FOUND',
  'AGENT_INACTIVE',
  'CAPABILITY_UNKNOWN',
  'CAPABILITY_NOT_GRANTED',
  'CAPABILITY_PRIVILEGED',
  'PRICE_TAMPER',
  'MALFORMED_PROPOSAL',
  'MANDATE_NOT_FOUND',
  'DUPLICATE_ACTION',
  // A read is still scoped: an agent may only inspect its own payments.
  'PAYMENT_NOT_OWNED',
  'PAYMENT_NOT_FOUND',
  // merchant policy — BLOCK
  'MERCHANT_MAX_ORDER_EXCEEDED',
  'MERCHANT_MAX_DISCOUNT_EXCEEDED',
  'MERCHANT_DAILY_BUDGET_EXCEEDED',
  'MERCHANT_MIN_MARGIN',
  'MERCHANT_UPSELL_NOT_PERMITTED',
  'MERCHANT_CART_MODIFICATION_NOT_PERMITTED',
  'PAYMENT_DUPLICATE',
  // user mandate boundary — REAUTHORIZE (user must expand authority)
  'MANDATE_EXPIRED',
  'MANDATE_SUPERSEDED',
  'MANDATE_AMOUNT_EXCEEDED',
  'MANDATE_CATEGORY_NOT_ALLOWED',
  'MANDATE_UPSELL_NOT_PERMITTED',
  // state integrity — REAUTHORIZE (or BLOCK when the cart is immutable)
  'CART_NOT_FOUND',
  'CART_STALE',
  'CART_IMMUTABLE',
  'CART_HASH_MISMATCH',
  'AUTHORIZATION_TTL_EXPIRED',
  // drift thresholds
  'DRIFT_APPROVAL_THRESHOLD',
  'DRIFT_BLOCK_THRESHOLD',
  // catalog / product state
  'PRODUCT_NOT_FOUND',
  'PRODUCT_INACTIVE',
] as const;

export type ViolationCode = (typeof VIOLATION_CODES)[number];

export const VIOLATION_BOUNDARY: Record<ViolationCode, ViolationBoundary> = {
  AGENT_NOT_FOUND: 'security',
  PAYMENT_NOT_OWNED: 'security',
  PAYMENT_NOT_FOUND: 'state',
  AGENT_INACTIVE: 'security',
  CAPABILITY_UNKNOWN: 'security',
  CAPABILITY_NOT_GRANTED: 'security',
  CAPABILITY_PRIVILEGED: 'security',
  PRICE_TAMPER: 'security',
  MALFORMED_PROPOSAL: 'security',
  MANDATE_NOT_FOUND: 'security',
  DUPLICATE_ACTION: 'security',
  MERCHANT_MAX_ORDER_EXCEEDED: 'merchant',
  MERCHANT_MAX_DISCOUNT_EXCEEDED: 'merchant',
  MERCHANT_DAILY_BUDGET_EXCEEDED: 'merchant',
  MERCHANT_MIN_MARGIN: 'merchant',
  MERCHANT_UPSELL_NOT_PERMITTED: 'merchant',
  MERCHANT_CART_MODIFICATION_NOT_PERMITTED: 'merchant',
  PAYMENT_DUPLICATE: 'merchant',
  MANDATE_EXPIRED: 'user',
  MANDATE_SUPERSEDED: 'user',
  MANDATE_AMOUNT_EXCEEDED: 'user',
  MANDATE_CATEGORY_NOT_ALLOWED: 'user',
  MANDATE_UPSELL_NOT_PERMITTED: 'user',
  CART_NOT_FOUND: 'state',
  CART_STALE: 'state',
  CART_IMMUTABLE: 'state',
  CART_HASH_MISMATCH: 'state',
  AUTHORIZATION_TTL_EXPIRED: 'state',
  DRIFT_APPROVAL_THRESHOLD: 'user',
  DRIFT_BLOCK_THRESHOLD: 'user',
  PRODUCT_NOT_FOUND: 'state',
  PRODUCT_INACTIVE: 'state',
};

export const VIOLATION_DECISION: Record<ViolationCode, Decision> = {
  AGENT_NOT_FOUND: 'BLOCK',
  PAYMENT_NOT_OWNED: 'BLOCK',
  PAYMENT_NOT_FOUND: 'BLOCK',
  AGENT_INACTIVE: 'BLOCK',
  CAPABILITY_UNKNOWN: 'BLOCK',
  CAPABILITY_NOT_GRANTED: 'BLOCK',
  CAPABILITY_PRIVILEGED: 'BLOCK',
  PRICE_TAMPER: 'BLOCK',
  MALFORMED_PROPOSAL: 'BLOCK',
  MANDATE_NOT_FOUND: 'BLOCK',
  DUPLICATE_ACTION: 'BLOCK',
  MERCHANT_MAX_ORDER_EXCEEDED: 'BLOCK',
  MERCHANT_MAX_DISCOUNT_EXCEEDED: 'BLOCK',
  MERCHANT_DAILY_BUDGET_EXCEEDED: 'BLOCK',
  MERCHANT_MIN_MARGIN: 'BLOCK',
  MERCHANT_UPSELL_NOT_PERMITTED: 'BLOCK',
  MERCHANT_CART_MODIFICATION_NOT_PERMITTED: 'BLOCK',
  PAYMENT_DUPLICATE: 'BLOCK',
  MANDATE_EXPIRED: 'REAUTHORIZE',
  MANDATE_SUPERSEDED: 'REAUTHORIZE',
  MANDATE_AMOUNT_EXCEEDED: 'REAUTHORIZE',
  MANDATE_CATEGORY_NOT_ALLOWED: 'REAUTHORIZE',
  MANDATE_UPSELL_NOT_PERMITTED: 'REAUTHORIZE',
  CART_NOT_FOUND: 'REAUTHORIZE',
  CART_STALE: 'REAUTHORIZE',
  CART_IMMUTABLE: 'BLOCK',
  CART_HASH_MISMATCH: 'REAUTHORIZE',
  AUTHORIZATION_TTL_EXPIRED: 'REAUTHORIZE',
  DRIFT_APPROVAL_THRESHOLD: 'HUMAN_APPROVAL',
  DRIFT_BLOCK_THRESHOLD: 'BLOCK',
  PRODUCT_NOT_FOUND: 'BLOCK',
  PRODUCT_INACTIVE: 'BLOCK',
};

export interface RuleViolation {
  code: ViolationCode;
  message: string;
  boundary: ViolationBoundary;
  /** The decision this single violation forces if it were the only one. */
  decision: Decision;
}

export function violation(code: ViolationCode, message: string): RuleViolation {
  return { code, message, boundary: VIOLATION_BOUNDARY[code], decision: VIOLATION_DECISION[code] };
}

export function decisionReason(decision: Decision, violations: readonly RuleViolation[]): string {
  if (decision === 'ALLOW') {
    return 'Action is within delegated user and merchant authority.';
  }
  const first = violations[0];
  return first ? first.message : `Decision: ${decision}.`;
}