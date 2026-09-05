// packages/shared/src/metrics.ts
import type { Decision } from './decisions';
import type { AuditChainStatus } from './audit';

/** Every value is computed from persisted application state (§48, §79). Never faked. */
export interface MetricsSnapshot {
  revenueGeneratedPaise: number;
  autonomousActions: number;
  blockedActions: number;
  humanApprovals: number;
  reauthorizations: number;
  duplicatePaymentsPrevented: number;
  currentDailyBudgetPaise: number;
  dailyBudgetLimitPaise: number;
  averageAuthorityDrift: number;
  fuzzCasesTested: number;
  policyBypasses: number;
  growthOpportunities: number;
  protocolTransactions: number;
  decisionCounts: Record<Decision, number>;
  auditChain: AuditChainStatus;
}