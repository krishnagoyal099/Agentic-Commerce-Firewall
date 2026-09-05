// apps/web/src/types/index.ts
/** Local mirrors for API responses not shaped by @acsf/shared DTOs. */
import type {
  Decision,
  DecisionReceipt,
  DriftBreakdown,
  FuzzBypassRecord,
  FuzzRunDTO,
  ProtocolRequestDTO,
  RuleViolation,
} from '@acsf/shared';

/** The persisted authorization_decisions row (JSON columns are typed). */
export interface DecisionDetail {
  id: string;
  actionId: string;
  sessionId: string | null;
  agentId: string;
  mandateId: string | null;
  mandateVersion: number | null;
  policyVersion: number;
  cartId: string | null;
  cartHash: string | null;
  protocol: string;
  actionType: string;
  actionSummary: string;
  amountPaise: number | null;
  decision: Decision;
  reason: string;
  violations: RuleViolation[];
  drift: DriftBreakdown | null;
  receipt: DecisionReceipt;
  idempotencyKey: string;
  approvedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
}

export interface ProtocolDemoStep {
  step: number;
  title: string;
  tool: string;
  protocolRequestId: string | null;
  decision: Decision | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

export interface ProtocolDemoReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  mandateId: string;
  cartId: string | null;
  orderId: string | null;
  paymentId: string | null;
  decisionId: string | null;
  steps: ProtocolDemoStep[];
  finalState: string;
  receiptText: string | null;
}

export interface ProtocolStatusResponse {
  adapters: Array<{ name: string; protocol: string; toolCount: number; tools: string[] }>;
  recentRequests: ProtocolRequestDTO[];
  totals: { accepted: number; denied: number; error: number };
  mcpServer: { transport: string; startCommand: string; note: string };
}

export interface FuzzRunInput {
  cases: number;
  seed: number;
  maxSequenceLength: number;
}

export interface FuzzRunResponse {
  run: FuzzRunDTO;
  bypasses: FuzzBypassRecord[];
  note: string;
}

export type CounterfactualParameter = 'discountPaise' | 'amountPaise' | 'mandateMaxPaise';

export interface CounterfactualRequest {
  parameter: CounterfactualParameter;
  /** Values in paise. */
  values: number[];
}

export interface AgentInfo {
  id: string;
  name: string;
  agentType: string;
  capabilities: string[];
  active: boolean;
}

export interface ProviderEventResult {
  paymentId: string;
  eventName: string;
  applied: boolean;
  duplicate: boolean;
  ignored: boolean;
  state: string;
  detail: string;
}

/** GET /api/intent/options — what the merchant stocks and how intent is parsed. */
export interface IntentOptions {
  categories: Array<{ id: string; label: string }>;
  presets: Array<{ label: string; intent: string }>;
  bounds: {
    minAmountRupees: number;
    maxAmountRupees: number;
    defaultAmountRupees: number;
    minTtlHours: number;
    maxTtlHours: number;
    defaultTtlHours: number;
  };
  llm: { enabled: boolean; model: string | null; warning: string | null };
}


/** GET /api/products — the catalog plus how heavily each product is referenced. */
export interface ProductUsage {
  cartLines: number;
  orders: number;
  opportunities: number;
}

export interface ProductsResponse {
  products: import('@acsf/shared').ProductDTO[];
  count: number;
  usage: Record<string, ProductUsage>;
}

/** Merchant-authored product fields. `malicious` is deliberately not one. */
export interface ProductCreateInput {
  sku: string;
  name: string;
  description: string;
  priceRupees: number;
  category: import('@acsf/shared').Category;
  marginPercent: number;
  active: boolean;
}

export type ProductPatchInput = Partial<ProductCreateInput>;
