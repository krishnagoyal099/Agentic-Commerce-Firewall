// packages/shared/src/receipts.ts
/**
 * Decision receipts (§45) — human-readable, structured, persisted with every decision.
 */
import { formatINR } from './money';
import { decisionReason } from './decisions';
import type { Decision, RuleViolation } from './decisions';
import type { DriftBreakdown } from './drift';
import type { ProtocolName } from './protocol';
import type { ActionType } from './actions';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN';

export interface ReceiptCheck {
  label: string;
  detail: string;
  status: CheckStatus;
}

export function check(label: string, detail: string, ok: boolean, warn = false): ReceiptCheck {
  return { label, detail, status: ok ? 'PASS' : warn ? 'WARN' : 'FAIL' };
}

export interface DecisionReceipt {
  receiptId: string;
  decisionId: string;
  actionId: string;
  generatedAt: string;
  protocol: ProtocolName;
  actor: { agentId: string; userId: string | null };
  action: {
    type: ActionType;
    summary: string;
    amountPaise: number | null;
    discountPaise: number | null;
    productIds: string[];
  };
  intent: {
    mandateId: string;
    version: number;
    intentText: string;
    maxAmountPaise: number;
    allowedCategories: string[];
    expiresAt: string;
    status: string;
  } | null;
  policy: {
    merchantId: string;
    version: number;
    maxOrderAmountPaise: number;
    maxDiscountPaise: number;
    dailyBudgetPaise: number;
    minimumMarginPercent: number;
    allowUpsells: boolean;
  } | null;
  policyChecks: ReceiptCheck[];
  integrityChecks: ReceiptCheck[];
  capability: { requested: string[]; granted: string[]; valid: boolean };
  /**
   * `evaluated` is false when the daily budget was not consulted for this
   * action — only payment.create spends money, so a cart.create receipt used to
   * claim ₹0 committed and the full budget remaining regardless of the real
   * spend. An unevaluated block must not read as a passing one.
   */
  budget: {
    evaluated: boolean;
    spentTodayPaise: number;
    limitPaise: number;
    remainingPaise: number;
    pass: boolean;
  };
  cartIntegrity: {
    cartId: string | null;
    authorizedHash: string | null;
    currentHash: string | null;
    match: boolean | null;
  };
  authorizationValidity: { ttlMinutes: number | null; evaluatedAt: string | null; valid: boolean | null };
  duplicateCheck: { idempotencyKey: string; duplicate: boolean; priorDecisionId: string | null };
  drift: DriftBreakdown | null;
  decision: Decision;
  reason: string;
  violations: RuleViolation[];
  policyVersion: number | null;
  mandateId: string | null;
}

const RULE = '─'.repeat(50);

/** Renders the plain-text receipt shown in the UI and returned by MCP get_decision_receipt. */
export function renderReceipt(r: DecisionReceipt): string {
  const out: string[] = [];
  out.push(RULE, 'AUTHORIZATION RECEIPT', RULE, '');

  out.push('ACTION', r.action.summary, '');

  if (r.intent) {
    out.push(
      'USER INTENT',
      r.intent.intentText,
      `Authority cap: ${formatINR(r.intent.maxAmountPaise)} (mandate v${r.intent.version}, ${r.intent.status})`,
      '',
    );
  }

  out.push('AGENT', r.actor.agentId, '');
  out.push('PROTOCOL', r.protocol, '');

  out.push('MERCHANT POLICY', '');
  for (const c of r.policyChecks) out.push(`  ${c.status === 'PASS' ? 'PASS' : c.status}   ${c.label.padEnd(28)} ${c.detail}`);
  out.push('');

  out.push('INTEGRITY', '');
  for (const c of r.integrityChecks) out.push(`  ${c.status === 'PASS' ? 'PASS' : c.status}   ${c.label.padEnd(28)} ${c.detail}`);
  out.push('');

  if (r.drift) {
    out.push('AUTHORITY DRIFT', '');
    out.push(`  Amount               ${r.drift.monetary.toFixed(2)}`);
    out.push(`  Category             ${r.drift.category.toFixed(2)}`);
    out.push(`  Discount             ${r.drift.discount.toFixed(2)}`);
    out.push(`  Temporal             ${r.drift.temporal.toFixed(2)}`);
    out.push(`  Action               ${r.drift.action.toFixed(2)}`);
    out.push(`  Overall              ${r.drift.overall.toFixed(2)}`);
    out.push('');
  }

  out.push('DECISION', '', r.decision, '');

  out.push('REASON', '', r.reason);

  if (r.decision !== 'ALLOW' && r.violations.length > 0) {
    out.push('', 'RULES VIOLATED', '');
    for (const v of r.violations) out.push(`  ${v.code} (${v.boundary}) — ${v.message}`);
    out.push('', 'OVERRIDE', '', 'Not permitted.');
  }

  out.push(RULE);
  return out.join('\n');
}

export { decisionReason };