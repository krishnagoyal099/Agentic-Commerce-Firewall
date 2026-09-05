// packages/shared/src/reports.ts
/** Cross-layer reports for the deterministic agents and demo orchestration. */
import type { AuditChainStatus, CartDTO, Decision, GrowthOpportunityDTO, MandatePlan, MetricsSnapshot, OrderDTO, PaymentDTO } from './index';

export interface BuyerStep {
  n: number;
  title: string;
  tool: string;
  summary: string;
  decision: Decision | null;
  detail: Record<string, unknown> | null;
}

export interface BuyerDiscoveredProduct {
  id: string;
  name: string;
  pricePaise: number;
  category: string;
}

export interface BuyerRunReport {
  agentId: string;
  mandateId: string;
  query: string;
  tokens: string[];
  discovered: BuyerDiscoveredProduct[];
  selected: { id: string; name: string; pricePaise: number } | null;
  cartId: string | null;
  steps: BuyerStep[];
  finalState: string;
}

export interface BuyerPurchaseReport {
  agentId: string;
  mandateId: string;
  cartId: string;
  decisionId: string | null;
  payment: PaymentDTO | null;
  order: OrderDTO | null;
  steps: BuyerStep[];
  finalState: string;
}

export interface GrowthAgentReport {
  agentId: string;
  opportunity: GrowthOpportunityDTO | null;
  decision: Decision | null;
  reason: string | null;
  applied: boolean;
  cart: CartDTO | null;
  note: string;
}

export interface AdversarialStep {
  attack: string;
  action: string;
  decision: Decision | null;
  reason: string | null;
  violationCodes: string[];
  note: string;
}

export interface AdversarialReport {
  agentId: string;
  mandateId: string;
  cartId: string | null;
  steps: AdversarialStep[];
  counts: { allow: number; humanApproval: number; reauthorize: number; block: number };
  finalState: string;
}

export interface DemoResetReport {
  reset: boolean;
  historyOrders: number;
  historyRevenuePaise: number;
  mandateId: string;
  resetAt: string;
  note: string;
  /** The mandate the run was issued from — the user's own intent, as parsed. */
  plan: MandatePlan;
  /** Product the generated history was anchored on, and its paired upsell. */
  history: { anchorProductId: string; companionProductId: string | null; adaptive: boolean };
}

export interface DemoStartReport {
  reset: DemoResetReport;
  buyer: BuyerRunReport;
  growth: GrowthAgentReport;
  purchase: BuyerPurchaseReport | null;
  metrics: MetricsSnapshot;
  auditChain: AuditChainStatus;
  receiptText: string | null;
  finalState: string;
  startedAt: string;
}

export interface DemoBootstrapResult {
  bootstrapped: boolean;
  reset: DemoResetReport | null;
}
