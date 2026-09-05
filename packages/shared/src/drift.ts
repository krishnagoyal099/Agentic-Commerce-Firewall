// packages/shared/src/drift.ts  (MODIFIED — cushion retuned to 25% after simulation)
/**
 * Authority drift (§23). Fully deterministic. No LLM ever computes this.
 *
 *   overall = monetary*0.30 + category*0.25 + discount*0.20 + temporal*0.10 + action*0.15
 *
 * Dimension definitions (all clamped to [0,1]):
 *   monetary  = non-core session spend / discretionary cushion
 *               (cushion = DRIFT_CUSHION_RATIO * mandate.max_amount)
 *               non-core = spend on items outside mandate.allowed_categories
 *   category  = DRIFT_CATEGORY_AVG_SCALE * avg(item distance from allowed categories)
 *               + DRIFT_CATEGORY_MAX_SCALE * max(item distance)
 *   discount  = session attempted discount total / policy.max_discount
 *   temporal  = fraction of mandate lifetime consumed at evaluation time
 *   action    = scope-expanding action count / DRIFT_DEVIATION_NORMALIZER
 *               scope-expanding attempts = non-core item add, discount attempt,
 *               post-authorization cart modification, refund request, payment retry
 *
 * monetary/category accumulate EXECUTED (allowed) effects;
 * discount/action accumulate ATTEMPTED effects (leading indicators).
 */
export type DriftDimension = 'monetary' | 'category' | 'discount' | 'temporal' | 'action';

export const DRIFT_WEIGHTS: Record<DriftDimension, number> = {
  monetary: 0.3,
  category: 0.25,
  discount: 0.2,
  temporal: 0.1,
  action: 0.15,
};

/** Discretionary cushion = 25% of the mandate cap. */
export const DRIFT_CUSHION_RATIO = 0.25;
/** Number of scope-expanding attempts that saturates action drift. */
export const DRIFT_DEVIATION_NORMALIZER = 4;
export const DRIFT_CATEGORY_AVG_SCALE = 1.25;
export const DRIFT_CATEGORY_MAX_SCALE = 0.25;
/** Policy defaults when a policy omits explicit thresholds. */
export const DRIFT_APPROVAL_DEFAULT = 0.7;
export const DRIFT_BLOCK_DEFAULT = 0.9;

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface DriftExplanation {
  monetary: string;
  category: string;
  discount: string;
  temporal: string;
  action: string;
  overall: string;
}

export interface DriftBreakdown {
  monetary: number;
  category: number;
  discount: number;
  temporal: number;
  action: number;
  overall: number;
  explanation: DriftExplanation;
}

export function computeOverallDrift(breakdown: Omit<DriftBreakdown, 'overall' | 'explanation'>): number {
  const raw =
    breakdown.monetary * DRIFT_WEIGHTS.monetary +
    breakdown.category * DRIFT_WEIGHTS.category +
    breakdown.discount * DRIFT_WEIGHTS.discount +
    breakdown.temporal * DRIFT_WEIGHTS.temporal +
    breakdown.action * DRIFT_WEIGHTS.action;
  return clamp01(Math.round(raw * 1000) / 1000);
}