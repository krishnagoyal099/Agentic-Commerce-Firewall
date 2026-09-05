// packages/shared/src/audit.ts  (MODIFIED — adds POLICY_CHANGE, CATALOG_CHANGE)
/**
 * Audit trail event types (§44) and the hash-chained event DTO.
 * The chain is SHA-256: eventHash = SHA256(canonical event fields + prevHash).
 */
import type { Decision } from './decisions';

export const AUDIT_EVENT_TYPES = [
  'USER_INTENT',
  'AGENT_DISCOVERY',
  'PROTOCOL_REQUEST',
  'CART_CREATED',
  'AGENT_PROPOSAL',
  'POLICY_EVALUATION',
  'POLICY_CHANGE',
  'CATALOG_CHANGE',
  'AUTHORIZATION',
  'PAYMENT_REQUEST',
  'PAYMENT_EVENT',
  'PAYMENT_RECONCILIATION',
  'ORDER_COMPLETED',
  'BLOCKED_ACTION',
  'HUMAN_APPROVAL',
  'REAUTHORIZATION',
  'GROWTH_OPPORTUNITY',
  'ATTACK_EXECUTED',
  'FUZZ_RUN',
  'SYSTEM',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEventDTO {
  eventId: string;
  sequence: number;
  timestamp: string;
  actor: string;
  eventType: AuditEventType;
  action: string | null;
  decision: Decision | null;
  reason: string | null;
  inputHash: string;
  policyVersion: number | null;
  previousEventHash: string | null;
  eventHash: string;
  payload: Record<string, unknown> | null;
}

export interface AuditChainStatus {
  valid: boolean;
  eventCount: number;
  firstInvalidSequence: number | null;
  message: string;
}