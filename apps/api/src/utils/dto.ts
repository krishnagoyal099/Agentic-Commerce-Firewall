// apps/api/src/utils/dto.ts  (MODIFIED — toDecisionSummary maps sessionId)
import type {
  CartDTO,
  CartLineDTO,
  DecisionSummaryDTO,
  MandateDTO,
  MandateStatus,
  OrderDTO,
  PolicyDTO,
  ProtocolRequestDTO,
} from '@acsf/shared';
import type { AuthorizationDecisionRow, MandateRow, OrderRow, PolicyRow, ProtocolRequestRow } from '../db/schema';
import type { CartView } from '../services/CartService';

export function toCartDTO(view: CartView): CartDTO {
  const lines: CartLineDTO[] = view.lines.map((line) => ({
    productId: line.productId,
    productName: line.productName,
    quantity: line.quantity,
    unitPricePaise: line.unitPricePaise,
    options: line.options,
    category: line.category,
    marginPercent: line.marginPercent,
  }));
  return {
    id: view.cart.id,
    mandateId: view.cart.mandateId,
    agentId: view.cart.agentId,
    state: view.cart.state,
    discountPaise: view.cart.discountPaise,
    subtotalPaise: view.subtotalPaise,
    totalPaise: view.totalPaise,
    lines,
    authorizedHash: view.cart.authorizedHash ?? null,
    currentHash: view.cart.currentHash ?? null,
    authorizationExpiresAt: view.cart.authorizationExpiresAt ?? null,
    protocol: view.cart.protocol,
    createdAt: view.cart.createdAt,
    updatedAt: view.cart.updatedAt,
  };
}

export function toOrderDTO(row: OrderRow): OrderDTO {
  return {
    id: row.id,
    cartId: row.cartId,
    mandateId: row.mandateId,
    agentId: row.agentId,
    status: row.status,
    totalPaise: row.totalPaise,
    productIds: row.productIds,
    protocol: row.protocol,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
  };
}

export function toMandateDTO(row: MandateRow, effectiveStatus: MandateStatus): MandateDTO {
  return {
    id: row.id,
    userId: row.userId,
    intent: row.intent,
    maxAmountPaise: row.maxAmountPaise,
    allowedCategories: row.allowedCategories,
    allowUpsell: row.allowUpsell,
    version: row.version,
    status: effectiveStatus,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    supersedesId: row.supersedesId ?? null,
    createdBy: row.createdBy,
  };
}

export function toPolicyDTO(row: PolicyRow, active: boolean): PolicyDTO {
  return {
    id: row.id,
    merchantId: row.merchantId,
    version: row.version,
    maxOrderAmountPaise: row.maxOrderAmountPaise,
    maxDiscountPaise: row.maxDiscountPaise,
    maxRefundPaise: row.maxRefundPaise,
    dailyBudgetPaise: row.dailyBudgetPaise,
    allowUpsells: row.allowUpsells,
    allowCartModification: row.allowCartModification,
    requireApprovalAboveDrift: row.requireApprovalAboveDrift,
    blockAboveDrift: row.blockAboveDrift,
    authorizationTtlMinutes: row.authorizationTtlMinutes,
    minimumMarginPercent: row.minimumMarginPercent,
    allowedCapabilities: row.allowedCapabilities,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    active,
  };
}

export function toDecisionSummary(row: AuthorizationDecisionRow): DecisionSummaryDTO {
  return {
    id: row.id,
    sessionId: row.sessionId ?? null,
    actionId: row.actionId,
    agentId: row.agentId,
    actionType: row.actionType,
    actionSummary: row.actionSummary,
    decision: row.decision,
    reason: row.reason,
    violationCodes: row.violations.map((v) => v.code),
    amountPaise: row.amountPaise ?? null,
    driftOverall: row.drift?.overall ?? null,
    protocol: row.protocol,
    policyVersion: row.policyVersion,
    mandateId: row.mandateId ?? null,
    cartId: row.cartId ?? null,
    approvedAt: row.approvedAt ?? null,
    consumedAt: row.consumedAt ?? null,
    createdAt: row.createdAt,
  };
}

export function toProtocolRequestDTO(row: ProtocolRequestRow): ProtocolRequestDTO {
  return {
    id: row.id,
    requestId: row.requestId,
    protocol: row.protocol,
    tool: row.tool,
    agentId: row.agentId,
    status: row.status,
    decision: row.decision ?? null,
    decisionId: row.decisionId ?? null,
    summary: row.summary,
    createdAt: row.createdAt,
  };
}