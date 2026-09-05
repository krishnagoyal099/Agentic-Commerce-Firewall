// packages/shared/src/counterfactual.ts
import type { Decision } from './decisions';

export const COUNTERFACTUAL_PARAMETERS = ['discountPaise', 'amountPaise', 'mandateMaxPaise'] as const;
export type CounterfactualParameter = (typeof COUNTERFACTUAL_PARAMETERS)[number];

export interface CounterfactualResult {
  parameter: CounterfactualParameter;
  value: number;
  decision: Decision;
  reason: string;
  drift: number | null;
}

export interface CounterfactualResponse {
  parameter: CounterfactualParameter;
  results: CounterfactualResult[];
  note: string;
}