// packages/shared/src/fuzzer.ts
import type { Decision } from './decisions';

export type FuzzCaseOutcome = Decision | 'ERROR';

/** Real counts produced by actually running every case through the firewall (§42). */
export interface FuzzRunStats {
  totalCases: number;
  allowed: number;
  blocked: number;
  reauthorized: number;
  humanApproval: number;
  policyViolations: number;
  bypasses: number;
  failures: number;
}

export interface FuzzRunDTO {
  id: string;
  seed: number;
  cases: number;
  maxSequenceLength: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stats: FuzzRunStats;
}

export interface FuzzBypassRecord {
  caseIndex: number;
  description: string;
  outcome: FuzzCaseOutcome;
  reason: string;
}