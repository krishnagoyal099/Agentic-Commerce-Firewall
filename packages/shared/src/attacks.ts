// packages/shared/src/attacks.ts
/**
 * Attack Lab catalog (§38). Each name maps to a real attack implementation in
 * apps/api/src/attacks/ that executes actual application logic.
 */
export const ATTACKS = [
  'unauthorized_discount',
  'malicious_catalog',
  'stale_cart',
  'payment_timeout',
  'slow_authority_drift',
  'budget_exhaustion',
  'unauthorized_refund',
  'capability_escalation',
  'protocol_bypass',
  'duplicate_payment',
] as const;
export type AttackName = (typeof ATTACKS)[number];

export type AttackCategory = 'authority' | 'payment' | 'protocol';

export interface AttackDescriptor {
  name: AttackName;
  title: string;
  description: string;
  category: AttackCategory;
}

export const ATTACK_INFO: Record<AttackName, AttackDescriptor> = {
  unauthorized_discount: {
    name: 'unauthorized_discount',
    title: 'Unauthorized Discount',
    description: 'Agent proposes a ₹2,000 discount against the ₹500 merchant cap.',
    category: 'authority',
  },
  malicious_catalog: {
    name: 'malicious_catalog',
    title: 'Malicious Catalog Injection',
    description: 'A product description carries injected agent instructions attempting to grant authority. Text is never authority.',
    category: 'authority',
  },
  stale_cart: {
    name: 'stale_cart',
    title: 'Stale Cart (Post-Authorization Tampering)',
    description: 'Cart is modified after authorization; the stored cart hash no longer matches.',
    category: 'authority',
  },
  payment_timeout: {
    name: 'payment_timeout',
    title: 'Payment Timeout → UNKNOWN',
    description: 'Provider times out; payment becomes UNKNOWN and must be reconciled — never blindly retried.',
    category: 'payment',
  },
  slow_authority_drift: {
    name: 'slow_authority_drift',
    title: 'Slow Authority Drift',
    description: 'Individually plausible actions accumulate drift until human approval is required.',
    category: 'authority',
  },
  budget_exhaustion: {
    name: 'budget_exhaustion',
    title: 'Daily Budget Exhaustion',
    description: 'Agent attempts to spend past the merchant daily budget after it is exhausted.',
    category: 'payment',
  },
  unauthorized_refund: {
    name: 'unauthorized_refund',
    title: 'Unauthorized Refund',
    description: 'Agent attempts refund.create — a privileged capability no agent may hold.',
    category: 'authority',
  },
  capability_escalation: {
    name: 'capability_escalation',
    title: 'Capability Escalation',
    description: 'Agent requests unknown and forbidden capabilities; unknown capabilities fail closed.',
    category: 'authority',
  },
  protocol_bypass: {
    name: 'protocol_bypass',
    title: 'Protocol Bypass Attempt',
    description: 'An MCP request tries to invoke a privileged tool (refund.create). Rejected at the protocol boundary; payment layer never reached.',
    category: 'protocol',
  },
  duplicate_payment: {
    name: 'duplicate_payment',
    title: 'Duplicate Payment Prevention',
    description: 'Payment replay + duplicate provider event; idempotency prevents double charging.',
    category: 'payment',
  },
};

export interface AttackStep {
  label: string;
  detail: string;
}

export interface AttackReport {
  attack: AttackName;
  title: string;
  executedAt: string;
  decision: import('./decisions').Decision;
  violatedRule: string | null;
  drift: number | null;
  steps: AttackStep[];
  decisionId: string | null;
  paymentId: string | null;
  auditEventId: string | null;
}