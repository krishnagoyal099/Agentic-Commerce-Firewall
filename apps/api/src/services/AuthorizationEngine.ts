// apps/api/src/services/AuthorizationEngine.ts
import { and, desc, eq, inArray, like } from 'drizzle-orm';
import {
  CART_ITEM_MAX_QUANTITY,
  CART_ITEM_OPTION_LIMITS,
  COMMITTED_SPEND_STATES,
  PROTOCOL_NAMES,
  actionSummary,
  categoryDistance,
  formatINR,
  mostSevere,
  nearestAllowedDistance,
  violation,
  type AgentAction,
  type ActionType,
  type Decision,
  type DecisionReceipt,
  type DriftBreakdown,
  type ProductDTO,
  type ReceiptCheck,
  type RuleViolation,
} from '@acsf/shared';
import { decisionReason } from '@acsf/shared';
import type { GrantableCapability } from '@acsf/shared';
import type { AppDatabase } from '../db/client';
import type {
  AgentRow,
  AuthorizationDecisionRow,
  DriftSessionRow,
  HumanApprovalRow,
  PolicyRow,
} from '../db/schema';
import * as schema from '../db/schema';
import { DomainError } from '../utils/errors';
import { sha256JSON } from '../utils/hash';
import { newId } from '../utils/ids';
import type { Clock } from '../utils/clock';
import type { AuditService } from './AuditService';
import type { AuthorityDriftEngine } from './AuthorityDriftEngine';
import type { CapabilityService } from './CapabilityService';
import type { CartIntegrityService } from './CartIntegrityService';
import type { CartService, CartView } from './CartService';
import type { CatalogService, ResolvedCartItem } from './CatalogService';
import type { MandateService, MandateView } from './MandateService';
import type { PolicyEngine } from './PolicyEngine';

export interface PaymentPlan {
  cartId: string;
  subtotalPaise: number;
  discountPaise: number;
  totalPaise: number;
  ttlExpiresAt: string;
}

export interface ModifyPlan {
  cartId: string;
  items: ResolvedCartItem[] | null;
  discountPaise: number | null;
}

export interface AuthorizationResult {
  decision: Decision;
  reason: string;
  violations: RuleViolation[];
  drift: DriftBreakdown | null;
  decisionId: string;
  receipt: DecisionReceipt;
  duplicateOf: string | null;
  sessionId: string | null;
  itemsToApply: ResolvedCartItem[] | null;
  modifyPlan: ModifyPlan | null;
  paymentPlan: PaymentPlan | null;
}

const MANDATE_REQUIRED: ReadonlySet<ActionType> = new Set([
  'cart.create',
  'cart.add_item',
  'cart.modify',
  'upsell.create',
  'payment.create',
] as const);

const DRIFT_SCOPED: ReadonlySet<ActionType> = new Set([
  'cart.add_item',
  'cart.modify',
  'upsell.create',
  'payment.create',
] as const);

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * THE FIREWALL (§22). Deterministic. No LLM calls. Every financial action on
 * the platform passes through evaluateAction() and receives exactly one of
 * ALLOW / HUMAN_APPROVAL / REAUTHORIZE / BLOCK with precedence
 * BLOCK > REAUTHORIZE > HUMAN_APPROVAL > ALLOW.
 *
 * Staged short-circuiting: structural → identity → capability → duplicate →
 * mandate → domain policy/mandate/cart checks → drift. Once a stage fails,
 * later stages are skipped. This is decision-equivalent to full composition
 * (every earlier failure is BLOCK or REAUTHORIZE, which outrank all later
 * outcomes) and keeps receipts clean.
 */
export class AuthorizationEngine {
  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
    private readonly merchantId: string,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
    private readonly mandates: MandateService,
    private readonly capabilities: CapabilityService,
    private readonly policies: PolicyEngine,
    private readonly cartIntegrity: CartIntegrityService,
    private readonly carts: CartService,
    private readonly driftEngine: AuthorityDriftEngine,
  ) {}

  // ---------- public API ----------

  evaluateAction(action: AgentAction): AuthorizationResult {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const violations: RuleViolation[] = [];

    let agent: AgentRow | null = null;
    let policy: PolicyRow | null = null;
    let granted: GrantableCapability[] = [];
    let mandate: MandateView | null = null;
    let session: DriftSessionRow | null = null;
    let duplicateOf: string | null = null;
    let resolvedItems: ResolvedCartItem[] | null = null;
    let cartView: CartView | null = null;
    let currentHash: string | null = null;
    let spentTodayPaise = 0;
    let budgetEvaluated = false;
    let scopeExpanding = false;
    let attemptedDiscountPaise = 0;
    let isRetry = false;
    let drift: DriftBreakdown | null = null;
    let outOfCategory = false;
    let paymentPlan: PaymentPlan | null = null;
    let modifyPlan: ModifyPlan | null = null;
    let prospectiveTotal: number | null = null;

    // ---- Stage 1: structure (MALFORMED_PROPOSAL → BLOCK) ----
    violations.push(...this.validateStructure(action));

    // ---- Stage 2: identity ----
    if (violations.length === 0) {
      agent = this.capabilities.getAgent(action.agentId);
      if (!agent) {
        violations.push(violation('AGENT_NOT_FOUND', `Unknown agent "${action.agentId}".`));
      } else if (!agent.active) {
        violations.push(violation('AGENT_INACTIVE', `Agent "${action.agentId}" is inactive.`));
      }
    }

    // ---- Stage 3: policy (deployment failure fails closed) ----
    if (violations.length === 0) {
      policy = this.policies.getActivePolicy(this.merchantId);
      if (!policy) {
        throw new DomainError('POLICY_MISSING', `Merchant policy is not configured for ${this.merchantId}.`);
      }
    }

    // ---- Stage 4: capability ----
    if (violations.length === 0 && policy) {
      const check = this.capabilities.check(action.agentId, action.type, action.requestedCapabilities, policy);
      violations.push(...check.violations);
      granted = check.granted;
    }

    // ---- Stage 5: duplicate / idempotency (§22 step 10, replay protection) ----
    if (violations.length === 0) {
      duplicateOf = this.findDuplicate(action);
      if (duplicateOf) {
        violations.push(
          violation(
            'DUPLICATE_ACTION',
            `Duplicate action: idempotency key "${action.idempotencyKey}" was already evaluated (${duplicateOf}).`,
          ),
        );
      }
    }

    // ---- Stage 6: mandate ----
    if (violations.length === 0 && MANDATE_REQUIRED.has(action.type)) {
      mandate = action.mandateId ? this.mandates.getMandate(action.mandateId) : null;
      if (!mandate) {
        violations.push(
          violation(
            'MANDATE_NOT_FOUND',
            action.mandateId
              ? `Mandate ${action.mandateId} does not exist.`
              : 'This action requires a user mandate; none was provided.',
          ),
        );
      } else if (mandate.effectiveStatus === 'expired') {
        violations.push(
          violation('MANDATE_EXPIRED', `Mandate ${mandate.row.id} expired at ${mandate.row.expiresAt}; user reauthorization required.`),
        );
      } else if (mandate.effectiveStatus === 'superseded') {
        violations.push(
          violation('MANDATE_SUPERSEDED', `Mandate ${mandate.row.id} was superseded by a newer version; reauthorization required.`),
        );
      }
    }

    // ---- Stage 7: domain checks (items, cart, policy amounts, mandate boundary) ----
    if (violations.length === 0 && policy && (mandate !== null || !MANDATE_REQUIRED.has(action.type))) {
      const domain = this.runDomainStage(action, mandate, policy, nowIso);
      violations.push(...domain.violations);
      resolvedItems = domain.resolvedItems;
      cartView = domain.cartView;
      currentHash = domain.currentHash;
      prospectiveTotal = domain.prospectiveTotal;
      outOfCategory = domain.outOfCategory;
      paymentPlan = domain.paymentPlan;
      spentTodayPaise = domain.spentTodayPaise;
      budgetEvaluated = domain.budgetEvaluated;
      isRetry = domain.isRetry;
    }

    // ---- Stage 8: drift session + thresholds ----
    //
    // Attempts are recorded whether or not the action passed. AuthorityDriftEngine
    // states this explicitly — "ATTEMPTED effects (discount, action-count):
    // recorded during evaluation, INCLUDING BLOCKED ATTEMPTS — drift is a
    // leading behavioral indicator" — but the recording sat behind
    // `violations.length === 0`, so probing was the one behaviour drift never
    // saw. An agent could request an over-cap discount a hundred times and its
    // score would not move. The THRESHOLD check stays gated on a clean
    // evaluation: drift may escalate an otherwise-allowed action, and must
    // never soften one that already has a violation.
    if (mandate !== null && policy !== null) {
      session = this.driftEngine.getSession(action.agentId, mandate.row.id, action.protocol);
      if (action.type === 'payment.create') {
        attemptedDiscountPaise = action.discountPaise;
      } else if (action.type === 'cart.modify') {
        attemptedDiscountPaise = action.discountPaise ?? 0;
      }
      scopeExpanding =
        (resolvedItems !== null &&
          resolvedItems.some((item) => !(mandate!.row.allowedCategories as string[]).includes(item.category))) ||
        // Any post-authorization cart mutation, not just cart.modify: an
        // upsell added to an authorized cart is the textbook drift case, and
        // the tampering test uses cart.add_item to do exactly that.
        ((action.type === 'cart.modify' || action.type === 'cart.add_item' || action.type === 'upsell.create') &&
          cartView !== null &&
          (cartView.cart.state === 'authorized' || cartView.cart.state === 'stale')) ||
        (action.type === 'payment.create' && isRetry) ||
        (action.type === 'payment.create' && action.discountPaise > 0) ||
        (action.type === 'cart.modify' && (action.discountPaise ?? 0) > 0);

      this.driftEngine.recordAttempt(session.id, { scopeExpanding, attemptedDiscountPaise });
      const updated = this.driftEngine.getSessionById(session.id);
      if (updated) {
        drift = this.driftEngine.computeBreakdown(updated, mandate.row, policy, now);
        if (violations.length === 0 && DRIFT_SCOPED.has(action.type)) {
          const blockThreshold = this.driftEngine.blockThreshold(policy);
          const approvalThreshold = this.driftEngine.approvalThreshold(policy);
          if (drift.overall > blockThreshold) {
            violations.push(
              violation(
                'DRIFT_BLOCK_THRESHOLD',
                `Authority drift ${drift.overall.toFixed(2)} is above the hard block threshold ${blockThreshold.toFixed(2)}.`,
              ),
            );
          } else if (drift.overall > approvalThreshold) {
            violations.push(
              violation(
                'DRIFT_APPROVAL_THRESHOLD',
                `Authority drift ${drift.overall.toFixed(2)} is above the approval threshold ${approvalThreshold.toFixed(2)}; human approval required.`,
              ),
            );
          }
        }
      }
    }

    // ---- Stage 9: decide ----
    const decision = violations.reduce<Decision>((acc, v) => mostSevere(acc, v.decision), 'ALLOW');
    const reason = decisionReason(decision, violations);

    // ---- Stage 10: execution plans (only ALLOW or approved-eligible HUMAN_APPROVAL) ----
    const executable = decision === 'ALLOW';
    if (executable) {
      if ((action.type === 'cart.create' || action.type === 'cart.add_item' || action.type === 'upsell.create') && resolvedItems) {
        // populated below
      }
      if (action.type === 'cart.modify') {
        modifyPlan = {
          cartId: action.cartId ?? '',
          items: resolvedItems,
          discountPaise: action.discountPaise ?? null,
        };
      }
    }
    const itemsToApply =
      executable && resolvedItems !== null && (action.type === 'cart.create' || action.type === 'cart.add_item' || action.type === 'upsell.create')
        ? resolvedItems
        : null;
    // Any non-ALLOW verdict clears every execution plan. Only HUMAN_APPROVAL was
    // cleared before, so a BLOCK for an exceeded budget, a failed margin check,
    // PRICE_TAMPER or a drift block still returned a fully-formed paymentPlan
    // to the caller. Nothing executes from it today — but shipping an execution
    // plan alongside a refusal is a contract waiting to be misread.
    if (!executable) {
      paymentPlan = null;
      modifyPlan = null;
    }

    // ---- Stage 11: persist decision ----
    const decisionId = newId('dec');
    const receipt = this.buildReceipt({
      action,
      decisionId,
      decision,
      reason,
      violations,
      agent,
      policy,
      mandate,
      drift,
      cartView,
      currentHash,
      spentTodayPaise,
      budgetEvaluated,
      duplicateOf,
      granted,
      outOfCategory,
      prospectiveTotal,
      nowIso,
    });

    this.db
      .insert(schema.authorizationDecisions)
      .values({
        id: decisionId,
        actionId: action.actionId,
        sessionId: session?.id ?? null,
        agentId: action.agentId,
        mandateId: mandate?.row.id ?? null,
        mandateVersion: mandate?.row.version ?? null,
        policyVersion: policy ? policy.version : 0,
        cartId: action.cartId,
        cartHash: currentHash,
        protocol: action.protocol,
        actionType: action.type,
        actionSummary: actionSummary(action),
        amountPaise: prospectiveTotal,
        decision,
        reason,
        violations,
        drift,
        receipt,
        idempotencyKey: action.idempotencyKey,
        approvalId: null,
        approvedAt: null,
        consumedAt: null,
        createdAt: nowIso,
      })
      .run();

    if (session && drift) {
      this.db
        .update(schema.driftSessions)
        .set({ currentBreakdown: drift, updatedAt: nowIso })
        .where(eq(schema.driftSessions.id, session.id))
        .run();
    }

    // ---- Stage 12: audit chain ----
    const inputHash = sha256JSON(action);
    const policyVersion = policy ? policy.version : null;
    if (action.type === 'catalog.read') {
      this.audit.append({
        actor: action.agentId,
        eventType: 'AGENT_DISCOVERY',
        action: actionSummary(action),
        inputHash,
        policyVersion,
        payload: { query: action.query, protocol: action.protocol, requestId: action.actionId },
      });
    } else {
      this.audit.append({
        actor: action.agentId,
        eventType: 'AGENT_PROPOSAL',
        action: actionSummary(action),
        inputHash,
        policyVersion,
        payload: { actionId: action.actionId, protocol: action.protocol, mandateId: action.mandateId, cartId: action.cartId },
      });
      this.audit.append({
        actor: 'firewall',
        eventType: 'POLICY_EVALUATION',
        action: actionSummary(action),
        reason: `${violations.length} rule violation(s) across policy v${policyVersion ?? 0}.`,
        inputHash,
        policyVersion,
        payload: { checks: violations.map((v) => v.code), decision },
      });
    }
    this.audit.append({
      actor: 'firewall',
      eventType: 'AUTHORIZATION',
      action: actionSummary(action),
      decision,
      reason,
      inputHash,
      policyVersion,
      payload: {
        decisionId,
        agentId: action.agentId,
        mandateId: mandate?.row.id ?? null,
        cartId: action.cartId,
        driftOverall: drift?.overall ?? null,
        sessionId: session?.id ?? null,
      },
    });
    if (decision === 'BLOCK') {
      this.audit.append({
        actor: 'firewall',
        eventType: 'BLOCKED_ACTION',
        action: actionSummary(action),
        decision,
        reason,
        inputHash,
        policyVersion,
        payload: { decisionId, violations: violations.map((v) => v.code) },
      });
    }

    return {
      decision,
      reason,
      violations,
      drift,
      decisionId,
      receipt,
      duplicateOf,
      sessionId: session?.id ?? null,
      itemsToApply,
      modifyPlan,
      paymentPlan,
    };
  }

  /** Human approval (§60): only a NON-AGENT may approve; the acting agent never can. */
  recordHumanApproval(
    decisionId: string,
    approvedBy: string,
    outcome: 'approved' | 'rejected',
    note?: string,
  ): { decision: AuthorizationDecisionRow; approval: HumanApprovalRow } {
    const row = this.getDecision(decisionId);
    if (!row) throw new DomainError('DECISION_NOT_FOUND', `Decision ${decisionId} does not exist.`);
    if (row.decision !== 'HUMAN_APPROVAL') {
      throw new DomainError('DECISION_NOT_APPROVAL_REQUIRED', `Decision ${decisionId} is ${row.decision}, not HUMAN_APPROVAL.`);
    }
    // A REJECTED review leaves approvedAt null, so approvedAt alone was not a
    // review guard: reject-then-approve walked straight past it and unlocked
    // execution, contradicting this method's own audit line ("execution remains
    // forbidden"). One review is final, whichever way it went.
    if (row.approvedAt !== null) {
      throw new DomainError('DECISION_ALREADY_APPROVED', `Decision ${decisionId} was already reviewed.`);
    }
    const priorReview = this.db
      .select({ id: schema.humanApprovals.id, outcome: schema.humanApprovals.outcome })
      .from(schema.humanApprovals)
      .where(eq(schema.humanApprovals.decisionId, decisionId))
      .limit(1)
      .get();
    if (priorReview) {
      throw new DomainError(
        'DECISION_ALREADY_APPROVED',
        `Decision ${decisionId} was already reviewed (${priorReview.outcome}); a review cannot be revisited.`,
      );
    }
    if (this.capabilities.getAgent(approvedBy)) {
      throw new DomainError('APPROVAL_BY_AGENT', `"${approvedBy}" is an agent; agents cannot approve their own requests.`);
    }
    const nowIso = this.clock.now().toISOString();
    const approvalId = newId('appr');
    const approval: HumanApprovalRow = {
      id: approvalId,
      decisionId,
      approvedBy,
      outcome,
      note: note ?? null,
      createdAt: nowIso,
    };
    this.db.insert(schema.humanApprovals).values(approval).run();
    if (outcome === 'approved') {
      this.db
        .update(schema.authorizationDecisions)
        .set({ approvedAt: nowIso, approvalId })
        .where(eq(schema.authorizationDecisions.id, decisionId))
        .run();
    }
    this.audit.append({
      actor: approvedBy,
      eventType: 'HUMAN_APPROVAL',
      action: `human.${outcome}`,
      decision: row.decision,
      reason:
        outcome === 'approved'
          ? 'Human approved the proposal; execution is now permitted for this decision.'
          : 'Human rejected the proposal; execution remains forbidden.',
      inputHash: sha256JSON({ decisionId, outcome }),
      policyVersion: row.policyVersion,
      payload: { decisionId, outcome, note: note ?? null },
    });
    const updated = this.getDecision(decisionId);
    if (!updated) throw new DomainError('DECISION_NOT_FOUND', 'Decision missing after approval.');
    return { decision: updated, approval };
  }

  getDecision(decisionId: string): AuthorizationDecisionRow | null {
    return (
      this.db
        .select()
        .from(schema.authorizationDecisions)
        .where(eq(schema.authorizationDecisions.id, decisionId))
        .get() ?? null
    );
  }

  getDecisionReceipt(decisionId: string): DecisionReceipt | null {
    return this.getDecision(decisionId)?.receipt ?? null;
  }

  listDecisions(options: { limit?: number; offset?: number; decision?: Decision } = {}): AuthorizationDecisionRow[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return this.db
      .select()
      .from(schema.authorizationDecisions)
      .where(options.decision ? eq(schema.authorizationDecisions.decision, options.decision) : undefined)
      // createdAt ties are routine (the clock is frozen for the duration of an
      // action, and the history bootstrap pins one clock per simulated day), so
      // paging on it alone can repeat or skip rows across page boundaries.
      .orderBy(desc(schema.authorizationDecisions.createdAt), desc(schema.authorizationDecisions.id))
      .limit(limit)
      .offset(Math.max(options.offset ?? 0, 0))
      .all();
  }

  /** Rising drift series for a session — the Authority Drift graph data. */
  listDecisionsBySession(sessionId: string): AuthorizationDecisionRow[] {
    return this.db
      .select()
      .from(schema.authorizationDecisions)
      .where(eq(schema.authorizationDecisions.sessionId, sessionId))
      .orderBy(schema.authorizationDecisions.createdAt)
      .all();
  }

  /**
   * Merchant daily budget already committed today.
   *
   * UNKNOWN counts. It is the state a provider timeout produces, and
   * PaymentReconciliationService documents it as "may already be CAPTURED at
   * the provider" — so excluding it made the budget under-count in exactly the
   * ambiguous case, letting an agent spend past the cap while real money sat
   * unaccounted. A spend ceiling must fail closed until reconciliation proves
   * the money did not move.
   */
  getCommittedSpendToday(): number {
    const today = this.clock.now().toISOString().slice(0, 10);
    const rows = this.db
      .select({ amountPaise: schema.payments.amountPaise })
      .from(schema.payments)
      .where(
        and(
          like(schema.payments.createdAt, `${today}%`),
          inArray(schema.payments.state, [...COMMITTED_SPEND_STATES]),
        ),
      )
      .all();
    return rows.reduce((sum, row) => sum + row.amountPaise, 0);
  }

  searchCatalog(query: string | null): ProductDTO[] {
    return this.catalog.searchProducts(query);
  }

  // ---------- private: structure ----------

  private validateStructure(action: AgentAction): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const bad = (message: string): void => {
      violations.push(violation('MALFORMED_PROPOSAL', message));
    };
    if (!isNonEmptyString(action.agentId, 64)) bad('agentId must be a string of 1-64 characters.');
    if (!isNonEmptyString(action.actionId, 128)) bad('actionId must be a string of 1-128 characters.');
    if (!isNonEmptyString(action.idempotencyKey, 128)) bad('idempotencyKey must be a string of 1-128 characters.');
    if (typeof action.timestamp !== 'string' || Number.isNaN(Date.parse(action.timestamp))) {
      bad('timestamp must be an ISO-8601 string.');
    }
    if (!Array.isArray(action.requestedCapabilities) || action.requestedCapabilities.length > 20) {
      bad('requestedCapabilities must be an array of at most 20 entries.');
    } else {
      for (const token of action.requestedCapabilities) {
        if (!isNonEmptyString(token, 64)) bad('Capability tokens must be strings of 1-64 characters.');
      }
    }
    if (!(PROTOCOL_NAMES as readonly string[]).includes(action.protocol)) {
      bad('protocol must be one of MCP, REST, INTERNAL.');
    }

    const validateItems = (items: readonly unknown[]): void => {
      if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
        bad('items must be an array of 1-50 entries.');
        return;
      }
      for (const spec of items) {
        if (!isPlainObject(spec)) {
          bad('Each item must be an object.');
          continue;
        }
        if (!isNonEmptyString(spec.productId, 64)) bad('Item productId must be a string of 1-64 characters.');
        const quantity = spec.quantity;
        if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
          bad(`Item ${String(spec.productId)} quantity must be an integer between 1 and 99.`);
        }
        if (spec.claimedUnitPricePaise !== undefined) {
          const claimed = spec.claimedUnitPricePaise;
          if (typeof claimed !== 'number' || !Number.isInteger(claimed) || claimed < 0) {
            bad('claimedUnitPricePaise must be a non-negative integer.');
          }
        }
        if (spec.options !== undefined) {
          if (!isPlainObject(spec.options)) {
            bad('Item options must be an object.');
          } else {
            const keys = Object.keys(spec.options);
            if (keys.length > CART_ITEM_OPTION_LIMITS.maxOptions) {
              bad(`Item options allow at most ${CART_ITEM_OPTION_LIMITS.maxOptions} keys.`);
            }
            for (const key of keys) {
              const value = spec.options[key];
              if (key.length > CART_ITEM_OPTION_LIMITS.maxKeyLength) {
                bad(`Option key exceeds ${CART_ITEM_OPTION_LIMITS.maxKeyLength} characters.`);
              }
              if (typeof value !== 'string' || value.length > CART_ITEM_OPTION_LIMITS.maxValueLength) {
                bad('Option values must be strings of at most 100 characters.');
              }
            }
          }
        }
      }
    };

    switch (action.type) {
      case 'catalog.read':
        if (action.query !== null && action.query.length > 200) bad('query must be at most 200 characters.');
        break;
      case 'cart.create':
        validateItems(action.items);
        break;
      case 'cart.add_item':
      case 'upsell.create':
        if (!isNonEmptyString(action.cartId, 64)) bad('cartId must be a string of 1-64 characters.');
        validateItems(action.items);
        break;
      case 'cart.modify':
        if (!isNonEmptyString(action.cartId, 64)) bad('cartId must be a string of 1-64 characters.');
        if (action.items !== undefined) validateItems(action.items);
        if (action.discountPaise !== undefined) {
          if (typeof action.discountPaise !== 'number' || !Number.isInteger(action.discountPaise) || action.discountPaise < 0) {
            bad('discountPaise must be a non-negative integer.');
          }
        }
        if (action.items === undefined && action.discountPaise === undefined) {
          bad('cart.modify requires items and/or discountPaise.');
        }
        break;
      case 'payment.create':
        if (!isNonEmptyString(action.cartId, 64)) bad('cartId must be a string of 1-64 characters.');
        if (typeof action.amountPaise !== 'number' || !Number.isInteger(action.amountPaise) || action.amountPaise < 0) {
          bad('amountPaise must be a non-negative integer.');
        }
        if (typeof action.discountPaise !== 'number' || !Number.isInteger(action.discountPaise) || action.discountPaise < 0) {
          bad('discountPaise must be a non-negative integer.');
        }
        break;
      case 'payment.query':
      case 'payment.reconcile':
        if (!isNonEmptyString(action.paymentId, 64)) bad('paymentId must be a string of 1-64 characters.');
        break;
      case 'refund.create':
        if (!isNonEmptyString(action.paymentId, 64)) bad('paymentId must be a string of 1-64 characters.');
        if (typeof action.amountPaise !== 'number' || !Number.isInteger(action.amountPaise) || action.amountPaise <= 0) {
          bad('refund amountPaise must be a positive integer.');
        }
        break;
      case 'policy.modify':
        if (!isPlainObject(action.policyPatch)) bad('policyPatch must be an object.');
        break;
      case 'mandate.modify':
        if (!isPlainObject(action.mandatePatch)) bad('mandatePatch must be an object.');
        break;
      case 'merchant.payout.modify':
      case 'settlement_account.modify':
        if (!isPlainObject(action.details)) bad('details must be an object.');
        break;
    }
    return violations;
  }

  // ---------- private: domain stage ----------

  private findDuplicate(action: AgentAction): string | null {
    const row = this.db
      .select({ id: schema.authorizationDecisions.id })
      .from(schema.authorizationDecisions)
      .where(
        and(
          eq(schema.authorizationDecisions.agentId, action.agentId),
          eq(schema.authorizationDecisions.actionType, action.type),
          eq(schema.authorizationDecisions.idempotencyKey, action.idempotencyKey),
        ),
      )
      // The dedupe index is deliberately NOT unique — every blocked replay
      // inserts another row with the same key — so without an ORDER BY the
      // receipt could cite a previously-blocked duplicate instead of the
      // original decision. Oldest first is the original.
      .orderBy(schema.authorizationDecisions.createdAt, schema.authorizationDecisions.id)
      .limit(1)
      .get();
    return row?.id ?? null;
  }

  private loadCart(action: AgentAction, mandate: MandateView | null): { cartView: CartView | null; violations: RuleViolation[] } {
    const violations: RuleViolation[] = [];
    const cartView = action.cartId ? this.carts.getCart(action.cartId) : null;
    if (!cartView) {
      violations.push(violation('CART_NOT_FOUND', `Cart ${action.cartId ?? '(none)'} does not exist; reauthorization required.`));
      return { cartView: null, violations };
    }
    if (mandate && cartView.cart.mandateId !== mandate.row.id) {
      violations.push(
        violation('CART_NOT_FOUND', `Cart ${cartView.cart.id} does not exist under mandate ${mandate.row.id}.`),
      );
      return { cartView: null, violations };
    }
    return { cartView, violations };
  }

  private checkMandateBoundary(
    totalPaise: number,
    discountPaise: number,
    newItems: readonly ResolvedCartItem[],
    mandate: MandateView,
    policy: PolicyRow,
    violations: RuleViolation[],
  ): boolean {
    let outOfCategory = false;
    if (totalPaise > mandate.row.maxAmountPaise) {
      violations.push(
        violation(
          'MANDATE_AMOUNT_EXCEEDED',
          `Order total ${formatINR(totalPaise)} exceeds the mandate cap ${formatINR(mandate.row.maxAmountPaise)}; user reauthorization required.`,
        ),
      );
    }
    const allowed = mandate.row.allowedCategories as string[];
    const offIntent = newItems.filter((item) => !allowed.includes(item.category));
    if (offIntent.length > 0) {
      outOfCategory = true;
      const latitude = mandate.row.allowUpsell && policy.allowUpsells;
      if (!latitude) {
        violations.push(
          violation(
            'MANDATE_CATEGORY_NOT_ALLOWED',
            `Item(s) ${offIntent.map((i) => i.productName).join(', ')} are outside the mandate's allowed categories ${allowed.join(', ')}; user reauthorization required.`,
          ),
        );
      }
    }
    if (discountPaise > mandate.row.maxAmountPaise) {
      violations.push(
        violation('MANDATE_AMOUNT_EXCEEDED', 'Discount exceeds the mandate amount; reauthorization required.'),
      );
    }
    return outOfCategory;
  }

  private checkMerchantOrderLimit(totalPaise: number, policy: PolicyRow, violations: RuleViolation[]): void {
    if (totalPaise > policy.maxOrderAmountPaise) {
      violations.push(
        violation(
          'MERCHANT_MAX_ORDER_EXCEEDED',
          `Order total ${formatINR(totalPaise)} exceeds the merchant hard limit ${formatINR(policy.maxOrderAmountPaise)}.`,
        ),
      );
    }
  }

  private cartHasPayments(cartId: string): boolean {
    const orderRows = this.db
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(eq(schema.orders.cartId, cartId))
      .all();
    if (orderRows.length === 0) return false;
    const paymentRows = this.db
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(
        inArray(
          schema.payments.orderId,
          orderRows.map((row) => row.id),
        ),
      )
      .limit(1)
      .all();
    return paymentRows.length > 0;
  }

  private runDomainStage(
    action: AgentAction,
    mandate: MandateView | null,
    policy: PolicyRow,
    nowIso: string,
  ): {
    violations: RuleViolation[];
    resolvedItems: ResolvedCartItem[] | null;
    cartView: CartView | null;
    currentHash: string | null;
    prospectiveTotal: number | null;
    outOfCategory: boolean;
    paymentPlan: PaymentPlan | null;
    spentTodayPaise: number;
    budgetEvaluated: boolean;
    isRetry: boolean;
  } {
    const violations: RuleViolation[] = [];
    let resolvedItems: ResolvedCartItem[] | null = null;
    let cartView: CartView | null = null;
    let currentHash: string | null = null;
    let prospectiveTotal: number | null = null;
    let outOfCategory = false;
    let paymentPlan: PaymentPlan | null = null;
    let spentTodayPaise = 0;
    let budgetEvaluated = false;
    let isRetry = false;

    switch (action.type) {
      case 'payment.query':
      case 'payment.reconcile': {
        // A read is still scoped. Neither of these required a mandate and
        // nothing tied the payment to the caller, so any agent holding
        // payment.create could read ANY payment — amount, provider payment id,
        // full state timeline — just by naming its id.
        const paymentRow =
          typeof action.paymentId === 'string'
            ? this.db.select().from(schema.payments).where(eq(schema.payments.id, action.paymentId)).get()
            : undefined;
        if (paymentRow === undefined) {
          violations.push(violation('PAYMENT_NOT_FOUND', `Payment ${action.paymentId ?? '—'} does not exist.`));
        } else if (paymentRow.agentId !== action.agentId) {
          violations.push(
            violation(
              'PAYMENT_NOT_OWNED',
              `Payment ${paymentRow.id} belongs to a different agent; an agent may only inspect its own payments.`,
            ),
          );
        }
        break;
      }

      case 'catalog.read':
      case 'refund.create':
      case 'policy.modify':
      case 'mandate.modify':
      case 'merchant.payout.modify':
      case 'settlement_account.modify':
        // Privileged types were already BLOCKed at the capability stage;
        // the catalog read carries no domain constraints here.
        break;

      case 'cart.create': {
        if (!mandate) break;
        const resolution = this.catalog.resolveItems(action.items);
        violations.push(...resolution.violations);
        if (resolution.violations.length === 0) {
          resolvedItems = resolution.items;
          prospectiveTotal = resolution.subtotalPaise;
          outOfCategory = this.checkMandateBoundary(prospectiveTotal, 0, resolution.items, mandate, policy, violations);
          this.checkMerchantOrderLimit(prospectiveTotal, policy, violations);
          currentHash = this.cartIntegrity.computeHash(
            resolution.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPricePaise: item.unitPricePaise,
              options: item.options ?? {},
            })),
            0,
          );
        }
        break;
      }

      case 'cart.add_item':
      case 'upsell.create': {
        if (!mandate) break;
        const loaded = this.loadCart(action, mandate);
        violations.push(...loaded.violations);
        cartView = loaded.cartView;
        if (!cartView) break;
        if (cartView.cart.state === 'paid') {
          violations.push(violation('CART_IMMUTABLE', `Cart ${cartView.cart.id} is paid and can no longer be modified.`));
          break;
        }
        const resolution = this.catalog.resolveItems(action.items);
        violations.push(...resolution.violations);
        // resolveItems caps a single request at 99 per line, but addItems SUMS
        // into an existing line — so two allowed adds of 99 produced a line of
        // 198, and N adds an unbounded one. Check the merged quantity, here,
        // where it can still become a violation rather than an exception after
        // the firewall has already said yes.
        let overQuantity = false;
        for (const item of resolution.items) {
          const existing = cartView.lines.find((line) => line.productId === item.productId);
          const merged = (existing?.quantity ?? 0) + item.quantity;
          if (merged > CART_ITEM_MAX_QUANTITY) {
            overQuantity = true;
            violations.push(
              violation(
                'MALFORMED_PROPOSAL',
                `Adding ${item.quantity} of ${item.productId} would take the cart line to ${merged}; the maximum per line is ${CART_ITEM_MAX_QUANTITY}.`,
              ),
            );
          }
        }
        if (resolution.violations.length === 0 && !overQuantity) {
          resolvedItems = resolution.items;
          prospectiveTotal = cartView.subtotalPaise + resolution.subtotalPaise - cartView.cart.discountPaise;
          outOfCategory = this.checkMandateBoundary(prospectiveTotal, cartView.cart.discountPaise, resolution.items, mandate, policy, violations);
          this.checkMerchantOrderLimit(prospectiveTotal, policy, violations);
          if (action.type === 'upsell.create') {
            if (!policy.allowUpsells) {
              violations.push(violation('MERCHANT_UPSELL_NOT_PERMITTED', 'Merchant policy does not permit agent-driven upsells.'));
            }
            if (!mandate.row.allowUpsell) {
              violations.push(
                violation('MANDATE_UPSELL_NOT_PERMITTED', 'User mandate does not permit upsells; reauthorization required.'),
              );
            }
          }
          if (!policy.allowCartModification) {
            violations.push(
              violation('MERCHANT_CART_MODIFICATION_NOT_PERMITTED', 'Merchant policy does not permit cart modification after creation.'),
            );
          }
          currentHash = this.cartIntegrity.hashForCart(cartView.cart.id);
        }
        break;
      }

      case 'cart.modify': {
        if (!mandate) break;
        const loaded = this.loadCart(action, mandate);
        violations.push(...loaded.violations);
        cartView = loaded.cartView;
        if (!cartView) break;
        if (cartView.cart.state === 'paid') {
          violations.push(violation('CART_IMMUTABLE', `Cart ${cartView.cart.id} is paid and can no longer be modified.`));
          break;
        }
        if (action.items !== undefined) {
          const resolution = this.catalog.resolveItems(action.items);
          violations.push(...resolution.violations);
          if (resolution.violations.length === 0) {
            resolvedItems = resolution.items;
          }
        }
        const newDiscount = action.discountPaise ?? null;
        const newSubtotal = resolvedItems !== null ? resolvedItems.reduce((s, i) => s + i.unitPricePaise * i.quantity, 0) : null;
        const effectiveDiscount = newDiscount !== null ? newDiscount : cartView.cart.discountPaise;
        if (effectiveDiscount > (newSubtotal ?? cartView.subtotalPaise)) {
          violations.push(violation('MALFORMED_PROPOSAL', 'Discount exceeds the cart subtotal.'));
          break;
        }
        if (newDiscount !== null && newDiscount > policy.maxDiscountPaise) {
          violations.push(
            violation(
              'MERCHANT_MAX_DISCOUNT_EXCEEDED',
              `Requested discount ${formatINR(newDiscount)} exceeds the merchant limit ${formatINR(policy.maxDiscountPaise)}.`,
            ),
          );
        }
        if (!policy.allowCartModification) {
          violations.push(
            violation('MERCHANT_CART_MODIFICATION_NOT_PERMITTED', 'Merchant policy does not permit cart modification after creation.'),
          );
        }
        const subtotal = newSubtotal ?? cartView.subtotalPaise;
        prospectiveTotal = subtotal - effectiveDiscount;
        outOfCategory = this.checkMandateBoundary(
          prospectiveTotal,
          effectiveDiscount,
          resolvedItems ?? [],
          mandate,
          policy,
          violations,
        );
        this.checkMerchantOrderLimit(prospectiveTotal, policy, violations);
        currentHash = this.cartIntegrity.hashForCart(cartView.cart.id);
        break;
      }

      case 'payment.create': {
        if (!mandate) break;
        const loaded = this.loadCart(action, mandate);
        violations.push(...loaded.violations);
        cartView = loaded.cartView;
        if (!cartView) break;
        const subtotal = cartView.subtotalPaise;
        // The cart may already carry a discount applied by an allowed
        // cart.modify. cart.add_item subtracts it; payment.create did not, so
        // the engine computed a total ABOVE what the cart itself displayed —
        // overcharging the buyer, and flagging PRICE_TAMPER against an honest
        // agent that reported the cart's own totalPaise.
        const discount = action.discountPaise + cartView.cart.discountPaise;
        if (discount > subtotal) {
          violations.push(violation('MALFORMED_PROPOSAL', 'Discount exceeds the cart subtotal.'));
          break;
        }
        if (discount > policy.maxDiscountPaise) {
          violations.push(
            violation(
              'MERCHANT_MAX_DISCOUNT_EXCEEDED',
              `Requested discount ${formatINR(discount)} exceeds the merchant limit ${formatINR(policy.maxDiscountPaise)}.`,
            ),
          );
        }
        // Cart lines are resolved against the catalog when they are ADDED and
        // never again, so a product the merchant deactivated afterwards — a
        // recall, an out-of-stock pull — was still charged for and shipped.
        // Re-check at the one moment money moves.
        for (const line of cartView.lines) {
          const product = this.catalog.getProduct(line.productId);
          if (product === null) {
            violations.push(
              violation('PRODUCT_NOT_FOUND', `Cart line ${line.productId} is no longer in the catalog.`),
            );
          } else if (!product.active) {
            violations.push(
              violation(
                'PRODUCT_INACTIVE',
                `${product.name} was deactivated after it was added to this cart and cannot be sold; remove it and re-propose.`,
              ),
            );
          }
        }
        const total = subtotal - discount;
        prospectiveTotal = total;
        if (action.amountPaise !== total) {
          violations.push(
            violation(
              'PRICE_TAMPER',
              `Agent claimed payment amount ${formatINR(action.amountPaise)} but the cart totals ${formatINR(total)}; server-side computation wins.`,
            ),
          );
        }
        if (total > mandate.row.maxAmountPaise) {
          violations.push(
            violation(
              'MANDATE_AMOUNT_EXCEEDED',
              `Order total ${formatINR(total)} exceeds the mandate cap ${formatINR(mandate.row.maxAmountPaise)}; user reauthorization required.`,
            ),
          );
        }
        this.checkMerchantOrderLimit(total, policy, violations);
        spentTodayPaise = this.getCommittedSpendToday();
        budgetEvaluated = true;
        if (spentTodayPaise + total > policy.dailyBudgetPaise) {
          violations.push(
            violation(
              'MERCHANT_DAILY_BUDGET_EXCEEDED',
              `Committed spend today ${formatINR(spentTodayPaise)} plus this order ${formatINR(total)} exceeds the merchant daily budget ${formatINR(policy.dailyBudgetPaise)}.`,
            ),
          );
        }
        // Margin floor: discount erodes margin; below minimum_margin_percent → BLOCK.
        const marginPaise =
          cartView.lines.reduce((sum, line) => sum + Math.round((line.unitPricePaise * line.quantity * line.marginPercent) / 100), 0) - discount;
        if (total <= 0 || (marginPaise / total) * 100 < policy.minimumMarginPercent) {
          violations.push(
            violation(
              'MERCHANT_MIN_MARGIN',
              `Effective margin ${(total > 0 ? (marginPaise / total) * 100 : 0).toFixed(1)}% is below the merchant minimum ${policy.minimumMarginPercent}%.`,
            ),
          );
        }
        currentHash = this.cartIntegrity.hashForCart(cartView.cart.id);
        isRetry = this.cartHasPayments(cartView.cart.id);
        if (cartView.cart.state === 'paid') {
          violations.push(violation('PAYMENT_DUPLICATE', `Cart ${cartView.cart.id} has already been paid.`));
          break;
        }
        if (cartView.cart.state === 'stale') {
          violations.push(
            violation(
              'CART_STALE',
              `Cart ${cartView.cart.id} was modified after authorization; reauthorization required.`,
            ),
          );
          break;
        }
        if (cartView.cart.state === 'authorized') {
          if (cartView.cart.authorizationExpiresAt && nowIso > cartView.cart.authorizationExpiresAt) {
            violations.push(
              violation(
                'AUTHORIZATION_TTL_EXPIRED',
                `Cart authorization expired at ${cartView.cart.authorizationExpiresAt} (TTL ${policy.authorizationTtlMinutes} min); reauthorization required.`,
              ),
            );
          } else {
            const freshHash = this.cartIntegrity.hashForCart(cartView.cart.id);
            if (freshHash && cartView.cart.authorizedHash && freshHash !== cartView.cart.authorizedHash) {
              violations.push(
                violation('CART_HASH_MISMATCH', 'Cart contents changed after authorization (hash mismatch); reauthorization required.'),
              );
            } else {
              violations.push(
                violation('PAYMENT_DUPLICATE', `A payment authorization already exists for cart ${cartView.cart.id}.`),
              );
            }
          }
          break;
        }
        // state === 'open': fresh, valid proposal.
        const ttlExpiresAt = new Date(
          this.clock.now().getTime() + policy.authorizationTtlMinutes * 60_000,
        ).toISOString();
        paymentPlan = {
          cartId: cartView.cart.id,
          subtotalPaise: subtotal,
          discountPaise: discount,
          totalPaise: total,
          ttlExpiresAt,
        };
        break;
      }
    }

    return {
      violations,
      resolvedItems,
      cartView,
      currentHash,
      prospectiveTotal,
      outOfCategory,
      paymentPlan,
      spentTodayPaise,
      budgetEvaluated,
      isRetry,
    };
  }

  // ---------- private: receipt ----------

  private buildReceipt(input: {
    action: AgentAction;
    decisionId: string;
    decision: Decision;
    reason: string;
    violations: RuleViolation[];
    agent: AgentRow | null;
    policy: PolicyRow | null;
    mandate: MandateView | null;
    drift: DriftBreakdown | null;
    cartView: CartView | null;
    currentHash: string | null;
    spentTodayPaise: number;
    budgetEvaluated: boolean;
    duplicateOf: string | null;
    granted: GrantableCapability[];
    outOfCategory: boolean;
    prospectiveTotal: number | null;
    nowIso: string;
  }): DecisionReceipt {
    const { action, decision, reason, violations, agent, policy, mandate, drift } = input;
    const codes = new Set(violations.map((v) => v.code));
    const ok = (code: string): ReceiptCheck['status'] => (codes.has(code as never) ? 'FAIL' : 'PASS');
    const amountPaise =
      action.type === 'payment.create' ? action.amountPaise : input.prospectiveTotal;
    const discountPaise =
      action.type === 'payment.create' ? action.discountPaise : action.type === 'cart.modify' ? action.discountPaise ?? 0 : 0;
    const productIds =
      action.type === 'cart.create' || action.type === 'cart.add_item' || action.type === 'upsell.create'
        ? action.items.map((item) => item.productId)
        : action.type === 'cart.modify' && action.items !== undefined
          ? action.items.map((item) => item.productId)
          : [];

    const policyChecks: ReceiptCheck[] = [];
    const integrityChecks: ReceiptCheck[] = [];

    if (policy) {
      if (input.prospectiveTotal !== null || action.type === 'payment.create') {
        policyChecks.push({
          label: 'Order limit',
          detail: `${formatINR(amountPaise ?? 0)} / ${formatINR(policy.maxOrderAmountPaise)}`,
          status: ok('MERCHANT_MAX_ORDER_EXCEEDED'),
        });
      }
      if (action.type === 'payment.create' || (action.type === 'cart.modify' && action.discountPaise !== undefined)) {
        policyChecks.push({
          label: 'Discount limit',
          detail: `${formatINR(discountPaise)} / ${formatINR(policy.maxDiscountPaise)}`,
          status: ok('MERCHANT_MAX_DISCOUNT_EXCEEDED'),
        });
      }
      if (action.type === 'payment.create') {
        policyChecks.push({
          label: 'Daily budget',
          detail: `${formatINR(input.spentTodayPaise)} committed + ${formatINR(action.amountPaise)} / ${formatINR(policy.dailyBudgetPaise)}`,
          status: ok('MERCHANT_DAILY_BUDGET_EXCEEDED'),
        });
        policyChecks.push({ label: 'Margin floor', detail: `${policy.minimumMarginPercent}% minimum`, status: ok('MERCHANT_MIN_MARGIN') });
      }
      if (action.type === 'upsell.create') {
        policyChecks.push({
          label: 'Upsells permitted',
          detail: policy.allowUpsells ? 'Merchant permits upsells' : 'Merchant forbids upsells',
          status: ok('MERCHANT_UPSELL_NOT_PERMITTED'),
        });
      }
      if (action.type === 'cart.add_item' || action.type === 'cart.modify') {
        policyChecks.push({
          label: 'Cart modification',
          detail: policy.allowCartModification ? 'Merchant permits cart modification' : 'Merchant forbids cart modification',
          status: ok('MERCHANT_CART_MODIFICATION_NOT_PERMITTED'),
        });
      }
    } else {
      policyChecks.push({ label: 'Policy evaluation', detail: 'Not evaluated — proposal malformed', status: 'FAIL' });
    }

    if (mandate) {
      integrityChecks.push({
        label: 'Mandate',
        detail: `${mandate.effectiveStatus} (v${mandate.row.version}, expires ${mandate.row.expiresAt})`,
        status: mandate.effectiveStatus === 'active' ? 'PASS' : 'FAIL',
      });
      if (input.prospectiveTotal !== null) {
        integrityChecks.push({
          label: 'Amount within intent',
          detail: `${formatINR(input.prospectiveTotal)} / ${formatINR(mandate.row.maxAmountPaise)}`,
          status: ok('MANDATE_AMOUNT_EXCEEDED'),
        });
      }
      const categoryStatus: ReceiptCheck['status'] = codes.has('MANDATE_CATEGORY_NOT_ALLOWED')
        ? 'FAIL'
        : input.outOfCategory
          ? 'WARN'
          : 'PASS';
      integrityChecks.push({
        label: 'Category within intent',
        detail: input.outOfCategory
          ? `Out-of-category item(s) permitted by upsell latitude (${(mandate.row.allowedCategories as string[]).join(', ')})`
          : `Within ${mandate.row.allowedCategories.join(', ')}`,
        status: categoryStatus,
      });
    } else if (action.type !== 'catalog.read' && action.type !== 'payment.query' && action.type !== 'payment.reconcile') {
      integrityChecks.push({ label: 'Mandate', detail: 'No valid mandate', status: 'FAIL' });
    }

    integrityChecks.push({
      label: 'Capability',
      detail: agent ? `Held: ${(input.granted).join(', ') || 'none'}` : 'Agent not identified',
      status: codes.has('CAPABILITY_UNKNOWN') || codes.has('CAPABILITY_NOT_GRANTED') || codes.has('CAPABILITY_PRIVILEGED') ? 'FAIL' : 'PASS',
    });
    integrityChecks.push({
      label: 'Duplicate action',
      detail: input.duplicateOf ? `Replay of ${input.duplicateOf}` : `Key ${action.idempotencyKey} is fresh`,
      status: ok('DUPLICATE_ACTION'),
    });
    if (action.type === 'payment.create' && input.cartView) {
      const freshHash = input.currentHash;
      const authorizedHash = input.cartView.cart.authorizedHash;
      integrityChecks.push({
        label: 'Cart unchanged',
        detail: authorizedHash ? `authorized ${authorizedHash.slice(0, 10)}… vs current ${freshHash?.slice(0, 10) ?? '…'}…` : 'No prior authorization on this cart',
        status: authorizedHash ? (authorizedHash === freshHash ? 'PASS' : 'FAIL') : 'PASS',
      });
      integrityChecks.push({
        label: 'Authorization validity',
        detail: input.cartView.cart.authorizationExpiresAt
          ? `TTL until ${input.cartView.cart.authorizationExpiresAt}`
          : `TTL ${policy?.authorizationTtlMinutes ?? '—'} min from approval`,
        status: ok('AUTHORIZATION_TTL_EXPIRED'),
      });
    }

    return {
      receiptId: newId('rcpt'),
      decisionId: input.decisionId,
      actionId: action.actionId,
      generatedAt: input.nowIso,
      protocol: action.protocol,
      actor: { agentId: action.agentId, userId: mandate?.row.userId ?? null },
      action: {
        type: action.type,
        summary: actionSummary(action),
        amountPaise: amountPaise ?? null,
        discountPaise: discountPaise,
        productIds,
      },
      intent: mandate
        ? {
            mandateId: mandate.row.id,
            version: mandate.row.version,
            intentText: mandate.row.intent,
            maxAmountPaise: mandate.row.maxAmountPaise,
            allowedCategories: mandate.row.allowedCategories as string[],
            expiresAt: mandate.row.expiresAt,
            status: mandate.effectiveStatus,
          }
        : null,
      policy: policy
        ? {
            merchantId: policy.merchantId,
            version: policy.version,
            maxOrderAmountPaise: policy.maxOrderAmountPaise,
            maxDiscountPaise: policy.maxDiscountPaise,
            dailyBudgetPaise: policy.dailyBudgetPaise,
            minimumMarginPercent: policy.minimumMarginPercent,
            allowUpsells: policy.allowUpsells,
          }
        : null,
      policyChecks,
      integrityChecks,
      capability: {
        requested: [...action.requestedCapabilities],
        granted: [...input.granted],
        valid: !violations.some((v) => v.code.startsWith('CAPABILITY')),
      },
      budget: {
        evaluated: input.budgetEvaluated,
        spentTodayPaise: input.spentTodayPaise,
        limitPaise: policy?.dailyBudgetPaise ?? 0,
        remainingPaise: (policy?.dailyBudgetPaise ?? 0) - input.spentTodayPaise,
        // An action that never touched the budget has not "passed" it.
        pass: input.budgetEvaluated && !codes.has('MERCHANT_DAILY_BUDGET_EXCEEDED'),
      },
      cartIntegrity: {
        cartId: action.cartId,
        authorizedHash: input.cartView?.cart.authorizedHash ?? null,
        currentHash: input.currentHash,
        match:
          input.cartView?.cart.authorizedHash && input.currentHash
            ? input.cartView.cart.authorizedHash === input.currentHash
            : null,
      },
      authorizationValidity: {
        ttlMinutes: policy?.authorizationTtlMinutes ?? null,
        evaluatedAt: input.cartView?.cart.authorizationExpiresAt ?? null,
        valid: !codes.has('AUTHORIZATION_TTL_EXPIRED'),
      },
      duplicateCheck: {
        idempotencyKey: action.idempotencyKey,
        duplicate: input.duplicateOf !== null,
        priorDecisionId: input.duplicateOf,
      },
      drift,
      decision,
      reason,
      violations,
      policyVersion: policy?.version ?? null,
      mandateId: mandate?.row.id ?? null,
    };
  }
}

export { categoryDistance };