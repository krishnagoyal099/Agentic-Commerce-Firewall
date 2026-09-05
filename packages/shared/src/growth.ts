// packages/shared/src/growth.ts
import type { Decision } from './decisions';

export interface GrowthStats {
  productIdA: string;
  productNameA: string;
  productIdB: string;
  productNameB: string;
  /** Fraction of orders containing A that also contain B. */
  coPurchaseRate: number;
  avgUpsellPaise: number;
  marginPercent: number;
  conversionCount: number;
  revenueContributionPaise: number;
}

export const GROWTH_OPPORTUNITY_STATUSES = ['PROPOSED', 'ALLOWED', 'BLOCKED', 'CONVERTED'] as const;
export type GrowthOpportunityStatus = (typeof GROWTH_OPPORTUNITY_STATUSES)[number];

export interface GrowthOpportunityDTO {
  id: string;
  type: 'upsell' | 'cross_sell' | 'bundle';
  productId: string;
  anchorProductId: string;
  amountPaise: number;
  reason: string;
  confidence: number;
  stats: GrowthStats | null;
  status: GrowthOpportunityStatus;
  decision: Decision | null;
  decisionId: string | null;
  proposedBy: string;
  createdAt: string;
}