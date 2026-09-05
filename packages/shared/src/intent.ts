// packages/shared/src/intent.ts
/**
 * Free-form user intent → a PROPOSED user mandate (§15).
 *
 * Nothing in this module is part of an authorization decision. It only helps a
 * human express the authority they want to grant: the resulting plan is fed to
 * MandateService, which validates it, and every later decision is made by the
 * deterministic AuthorizationEngine against the *stored* mandate. An LLM may
 * draft a plan; it can never widen one, because every field is clamped here and
 * re-validated by Zod before a mandate row exists.
 */
import { CATEGORIES, isCategory, type Category } from './categories';

export type MandatePlanSource = 'llm' | 'deterministic';

export interface PlanProduct {
  id: string;
  name: string;
  pricePaise: number;
  category: Category;
}

export interface MandatePlan {
  /** The user's own words, preserved verbatim for the receipt. */
  intent: string;
  maxAmountRupees: number;
  allowedCategories: Category[];
  allowUpsell: boolean;
  ttlHours: number;
  source: MandatePlanSource;
  /** One line explaining how the plan was derived. Shown, never trusted. */
  rationale: string;
  warnings: string[];
  /** Catalog products the intent actually matches, cheapest first. */
  matches: PlanProduct[];
  /** Product the generated demo history is anchored on (null → nothing matched). */
  anchorProductId: string | null;
  /** Cheaper adjacent-category product paired with the anchor in history. */
  companionProductId: string | null;
}

export interface IntentPlanReport {
  plan: MandatePlan;
  llm: {
    attempted: boolean;
    used: boolean;
    model: string | null;
    latencyMs: number | null;
    error: string | null;
  };
}

/** Mandate bounds. The LLM's output is clamped into these before use. */
export const MANDATE_BOUNDS = {
  minAmountRupees: 1,
  maxAmountRupees: 10_000_000,
  defaultAmountRupees: 8_000,
  minTtlHours: 1,
  maxTtlHours: 2160,
  defaultTtlHours: 24,
} as const;

export const INTENT_PRESETS: ReadonlyArray<{ label: string; intent: string }> = [
  { label: 'Marathon shoes', intent: 'I need running shoes for my upcoming marathon under ₹8,000.' },
  { label: 'GPS watch', intent: 'Buy me a GPS running watch under ₹15,000 for marathon pacing.' },
  { label: 'Gym kit', intent: 'I want a sports water bottle and running socks for the gym, under ₹1,500.' },
  { label: 'Over budget', intent: 'Get me a gaming laptop under ₹80,000.' },
];

/** Keyword → category table used by the deterministic parser. */
export const CATEGORY_KEYWORDS: Record<Category, readonly string[]> = {
  // Deliberately excludes the bare word "running": it appears in running socks,
  // running watches and running insoles too, and must not silently unlock
  // footwear authority. "shoe"/"sneaker"/"marathon" are the real signals.
  running_shoes: [
    'shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers', 'footwear',
    'marathon', 'jogging', 'racing',
  ],
  running_accessories: [
    'sock', 'socks', 'insole', 'insoles', 'lace', 'laces', 'accessory',
    'accessories', 'compression', 'arch',
  ],
  sports: [
    'bottle', 'water', 'hydration', 'gym', 'sport', 'sports', 'fitness',
    'workout', 'training', 'exercise',
  ],
  electronics: [
    'watch', 'smartwatch', 'gps', 'tracker', 'laptop', 'computer', 'gaming',
    'electronic', 'electronics', 'device', 'gadget', 'headphone', 'headphones',
    'earbud', 'earbuds', 'phone',
  ],
  warranty: ['warranty', 'protection', 'insurance', 'coverage', 'extended', 'guarantee'],
};

const BUDGET_CUE = /(under|below|within|upto|up\s*to|max|maximum|budget|less\s+than|no\s+more\s+than|around|about)\s*(?:of\s*)?(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakh|lakhs|l)?/gi;
const BARE_AMOUNT = /(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakh|lakhs|l)?|(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakh|lakhs)\b/gi;

function scaleOf(unit: string | undefined): number {
  if (unit === undefined) return 1;
  const u = unit.toLowerCase();
  if (u === 'k' || u === 'thousand') return 1_000;
  if (u === 'lakh' || u === 'lakhs' || u === 'l') return 100_000;
  return 1;
}

/** Extracts a rupee budget from free text. Returns null when none is stated. */
export function parseBudgetRupees(intent: string): number | null {
  const found: number[] = [];
  for (const match of intent.matchAll(BUDGET_CUE)) {
    const value = Number(String(match[2]).replace(/,/g, '')) * scaleOf(match[3]);
    if (Number.isFinite(value) && value > 0) found.push(value);
  }
  if (found.length === 0) {
    for (const match of intent.matchAll(BARE_AMOUNT)) {
      const raw = match[1] ?? match[3];
      const unit = match[2] ?? match[4];
      if (raw === undefined) continue;
      const value = Number(String(raw).replace(/,/g, '')) * scaleOf(unit);
      if (Number.isFinite(value) && value > 0) found.push(value);
    }
  }
  if (found.length === 0) return null;
  const budget = Math.round(Math.max(...found));
  return clampAmountRupees(budget);
}

export function clampAmountRupees(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return MANDATE_BOUNDS.defaultAmountRupees;
  return Math.min(MANDATE_BOUNDS.maxAmountRupees, Math.max(MANDATE_BOUNDS.minAmountRupees, rounded));
}

export function clampTtlHours(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return MANDATE_BOUNDS.defaultTtlHours;
  return Math.min(MANDATE_BOUNDS.maxTtlHours, Math.max(MANDATE_BOUNDS.minTtlHours, rounded));
}

/** Keeps only real categories, de-duplicated and in CATEGORIES order. */
export function normaliseCategories(values: readonly string[]): Category[] {
  const seen = new Set<Category>();
  for (const value of values) {
    const trimmed = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (isCategory(trimmed)) seen.add(trimmed);
  }
  return CATEGORIES.filter((category) => seen.has(category));
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'i', 'need', 'want', 'buy', 'get', 'for', 'under', 'over', 'below', 'above',
  'my', 'the', 'a', 'an', 'to', 'and', 'with', 'of', 'in', 'on', 'at', 'some',
  'me', 'please', 'upcoming', 'new', 'good', 'best', 'pair', 'about', 'around',
]);

/** Content words of an intent — no digits, no stopwords. */
export function intentKeywords(intent: string): string[] {
  return intent
    .toLowerCase()
    .replace(/[₹,]/g, ' ')
    .split(/[^a-z]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/**
 * Deterministic intent → categories. Matches the keyword table first; a
 * singular/plural stem match counts. Empty result means "nothing recognised".
 */
export function categoriesFromIntent(intent: string): Category[] {
  const words = intentKeywords(intent);
  const hits = new Set<Category>();
  for (const category of CATEGORIES) {
    const keywords = CATEGORY_KEYWORDS[category];
    for (const word of words) {
      const stem = word.endsWith('s') ? word.slice(0, -1) : word;
      if (keywords.includes(word) || keywords.includes(stem)) {
        hits.add(category);
        break;
      }
    }
  }
  return CATEGORIES.filter((category) => hits.has(category));
}
