// packages/shared/src/commerce.ts  (MODIFIED — DecisionSummaryDTO gains sessionId)
/** Wire DTOs for carts, orders, mandates, policies, and decision summaries. */
import type { Decision, ProtocolName } from './index';
import type { Category, CartState, MandateStatus } from './index';

export interface CartLineDTO {
  productId: string;
  productName: string;
  quantity: number;
  unitPricePaise: number;
  options: Record<string, string>;
  category: Category;
  marginPercent: number;
}

export interface CartDTO {
  id: string;
  mandateId: string;
  agentId: string;
  state: CartState;
  discountPaise: number;
  subtotalPaise: number;
  totalPaise: number;
  lines: CartLineDTO[];
  authorizedHash: string | null;
  currentHash: string | null;
  authorizationExpiresAt: string | null;
  protocol: ProtocolName;
  createdAt: string;
  updatedAt: string;
}

export interface OrderDTO {
  id: string;
  cartId: string;
  mandateId: string;
  agentId: string;
  status: 'pending' | 'completed' | 'failed';
  totalPaise: number;
  productIds: string[];
  protocol: ProtocolName;
  createdAt: string;
  completedAt: string | null;
}

export interface MandateDTO {
  id: string;
  userId: string;
  intent: string;
  maxAmountPaise: number;
  allowedCategories: string[];
  allowUpsell: boolean;
  version: number;
  status: MandateStatus;
  issuedAt: string;
  expiresAt: string;
  supersedesId: string | null;
  createdBy: string;
}

export interface PolicyDTO {
  id: string;
  merchantId: string;
  version: number;
  maxOrderAmountPaise: number;
  maxDiscountPaise: number;
  maxRefundPaise: number;
  dailyBudgetPaise: number;
  allowUpsells: boolean;
  allowCartModification: boolean;
  requireApprovalAboveDrift: number;
  blockAboveDrift: number;
  authorizationTtlMinutes: number;
  minimumMarginPercent: number;
  allowedCapabilities: string[];
  createdBy: string;
  createdAt: string;
  active: boolean;
}

export interface DecisionSummaryDTO {
  id: string;
  sessionId: string | null;
  actionId: string;
  agentId: string;
  actionType: string;
  actionSummary: string;
  decision: Decision;
  reason: string;
  violationCodes: string[];
  amountPaise: number | null;
  driftOverall: number | null;
  protocol: ProtocolName;
  policyVersion: number;
  mandateId: string | null;
  cartId: string | null;
  approvedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
}