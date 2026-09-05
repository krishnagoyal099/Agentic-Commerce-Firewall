// packages/shared/src/categories.ts  (MODIFIED — adds isCategory guard)
/**
 * Deterministic category-distance table (§24).
 * Distance semantics: 0 = exactly the user's stated need, 1 = fully unrelated authority.
 */
export const CATEGORIES = [
  'running_shoes',
  'running_accessories',
  'sports',
  'electronics',
  'warranty',
] as const;
export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

export const CATEGORY_LABELS: Record<Category, string> = {
  running_shoes: 'Running Shoes',
  running_accessories: 'Running Accessories',
  sports: 'Sports',
  electronics: 'Electronics',
  warranty: 'Warranty',
};

/**
 * Symmetric distance matrix. Documented values:
 *   running_shoes -> running_shoes        0.00
 *   running_shoes -> running_accessories  0.25
 *   running_shoes -> sports               0.50
 *   running_shoes -> warranty             0.70
 *   running_shoes -> electronics          1.00
 *   running_accessories -> sports         0.40
 *   running_accessories -> warranty       0.60
 *   running_accessories -> electronics    0.90
 *   sports -> warranty                    0.60
 *   sports -> electronics                 0.70
 *   warranty -> electronics               0.80
 * Unlisted pairs default to 1.00.
 */
export const CATEGORY_DISTANCE: Record<Category, Record<Category, number>> = {
  running_shoes: {
    running_shoes: 0.0,
    running_accessories: 0.25,
    sports: 0.5,
    electronics: 1.0,
    warranty: 0.7,
  },
  running_accessories: {
    running_shoes: 0.25,
    running_accessories: 0.0,
    sports: 0.4,
    electronics: 0.9,
    warranty: 0.6,
  },
  sports: {
    running_shoes: 0.5,
    running_accessories: 0.4,
    sports: 0.0,
    electronics: 0.7,
    warranty: 0.6,
  },
  electronics: {
    running_shoes: 1.0,
    running_accessories: 0.9,
    sports: 0.7,
    electronics: 0.0,
    warranty: 0.8,
  },
  warranty: {
    running_shoes: 0.7,
    running_accessories: 0.6,
    sports: 0.6,
    electronics: 0.8,
    warranty: 0.0,
  },
};

export function categoryDistance(a: Category, b: Category): number {
  const row = CATEGORY_DISTANCE[a];
  const value = row ? row[b] : undefined;
  return value === undefined ? 1.0 : value;
}

/** Distance from a category to the NEAREST of the mandate's allowed categories. */
export function nearestAllowedDistance(category: Category, allowed: readonly string[]): number {
  let best = 1;
  for (const candidate of allowed) {
    if (isCategory(candidate)) {
      best = Math.min(best, categoryDistance(category, candidate));
    }
  }
  return best;
}