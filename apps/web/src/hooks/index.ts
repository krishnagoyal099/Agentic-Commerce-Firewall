// apps/web/src/hooks/index.ts  (FULL FINAL — fixes the non-existent
// `ProtocolDemoReport` export in @acsf/shared; that type lives in web/src/types)
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdversarialReport,
  AuditChainStatus,
  AuditEventDTO,
  AuditEventType,
  CounterfactualResponse,
  Decision,
  DecisionSummaryDTO,
  DemoResetReport,
  DemoStartReport,
  GrowthAgentReport,
  GrowthOpportunityDTO,
  GrowthStats,
  IntentPlanReport,
  MandateDTO,
  MetricsSnapshot,
  PaymentDTO,
  ProductDTO,
  PolicyDTO,
  ReconciliationReportDTO,
} from '@acsf/shared';
import { api } from '../api/client';
import type {
  AgentInfo,
  CounterfactualRequest,
  DecisionDetail,
  FuzzRunInput,
  FuzzRunResponse,
  IntentOptions,
  ProductCreateInput,
  ProductPatchInput,
  ProductsResponse,
  ProtocolDemoReport,
  ProtocolStatusResponse,
  ProviderEventResult,
} from '../types';

// ---------- queries ----------

export function useMetrics() {
  return useQuery({
    queryKey: ['metrics'],
    queryFn: () => api.get<MetricsSnapshot>('/api/metrics'),
    refetchInterval: 5000,
  });
}

export function useDecisions(decision?: Decision) {
  return useQuery({
    queryKey: ['decisions', decision ?? 'ALL'],
    queryFn: () =>
      api.get<{ decisions: DecisionSummaryDTO[] }>(
        `/api/decisions?limit=60${decision ? `&decision=${decision}` : ''}`,
      ),
    refetchInterval: 6000,
  });
}

export function useDecisionsBySession(sessionId: string | null) {
  return useQuery({
    queryKey: ['decisions', 'session', sessionId],
    queryFn: () =>
      api.get<{ decisions: DecisionSummaryDTO[] }>(`/api/decisions?sessionId=${sessionId ?? ''}`),
    enabled: sessionId !== null,
  });
}

export function useDecisionDetail(id: string | null) {
  return useQuery({
    queryKey: ['decision', id],
    queryFn: () => api.get<{ decision: DecisionDetail; rendered: string }>(`/api/decisions/${id ?? ''}`),
    enabled: id !== null,
  });
}

export function usePayments() {
  return useQuery({
    queryKey: ['payments'],
    queryFn: () => api.get<{ payments: PaymentDTO[] }>('/api/payments'),
    refetchInterval: 5000,
  });
}

export function useAuditEvents(eventType?: AuditEventType) {
  return useQuery({
    queryKey: ['audit', eventType ?? 'ALL'],
    queryFn: () =>
      api.get<{ events: AuditEventDTO[]; count: number }>(
        `/api/audit-events?limit=200${eventType ? `&eventType=${eventType}` : ''}`,
      ),
    refetchInterval: 8000,
  });
}

export function useChainStatus() {
  return useQuery({
    queryKey: ['audit', 'chain'],
    queryFn: () => api.get<AuditChainStatus>('/api/audit/verify'),
    refetchInterval: 8000,
  });
}

export function useGrowthAnalytics() {
  return useQuery({
    queryKey: ['growth', 'analytics'],
    queryFn: () => api.get<{ analytics: GrowthStats[]; source: string }>('/api/growth/analytics'),
    refetchInterval: 10000,
  });
}

export function useGrowthOpportunities() {
  return useQuery({
    queryKey: ['growth', 'opportunities'],
    queryFn: () => api.get<{ opportunities: GrowthOpportunityDTO[] }>('/api/growth/opportunities'),
    refetchInterval: 8000,
  });
}

export function useProtocolStatus() {
  return useQuery({
    queryKey: ['protocol', 'status'],
    queryFn: () => api.get<ProtocolStatusResponse>('/api/protocol/status'),
    refetchInterval: 4000,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: AgentInfo[] }>('/api/agents'),
  });
}

export function usePolicy() {
  return useQuery({
    queryKey: ['policy'],
    queryFn: () => api.get<{ active: PolicyDTO | null; versions: PolicyDTO[] }>('/api/policy'),
    refetchInterval: 15000,
  });
}

export function useProducts() {
  return useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<ProductsResponse>('/api/products'),
  });
}

export function useMandates() {
  return useQuery({
    queryKey: ['mandates'],
    queryFn: () => api.get<{ mandates: MandateDTO[] }>('/api/mandates'),
  });
}

// ---------- mutations (every success invalidates all queries —
// the UI can only ever re-render SERVER-computed state) ----------

function useInvalidatingMutation<TInput, TOutput>(fn: (input: TInput) => Promise<TOutput>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
}

export interface DemoRunOptions {
  intent?: string;
  maxAmountRupees?: number;
  allowedCategories?: string[];
  allowUpsell?: boolean;
  ttlHours?: number;
}

export function useDemoStart() {
  return useInvalidatingMutation((options: DemoRunOptions = {}) =>
    api.post<DemoStartReport>('/api/demo/start', options),
  );
}

export function useDemoReset() {
  return useInvalidatingMutation((options: DemoRunOptions = {}) =>
    api.post<DemoResetReport>('/api/demo/reset', options),
  );
}

// ---------- intent → proposed mandate (drafting only; creates no authority) ----------

export function useIntentOptions() {
  return useQuery({
    queryKey: ['intent-options'],
    queryFn: () => api.get<IntentOptions>('/api/intent/options'),
    staleTime: Infinity,
  });
}

export function useIntentPlan() {
  return useMutation({
    mutationFn: (input: { intent: string } & DemoRunOptions) =>
      api.post<IntentPlanReport>('/api/intent/plan', input),
  });
}

// ---------- merchant catalog administration (never reachable by an agent) ----------

export function useProductCreate() {
  return useInvalidatingMutation((input: { updatedBy: string; product: ProductCreateInput }) =>
    api.post<{ product: ProductDTO }>('/api/products', input),
  );
}

export function useProductUpdate() {
  return useInvalidatingMutation((input: { productId: string; updatedBy: string; patch: ProductPatchInput }) =>
    api.patch<{ product: ProductDTO }>(`/api/products/${input.productId}`, {
      updatedBy: input.updatedBy,
      patch: input.patch,
    }),
  );
}

export function useProductDelete() {
  return useInvalidatingMutation((input: { productId: string; updatedBy: string }) =>
    api.del<{ deleted: true; productId: string }>(`/api/products/${input.productId}`, {
      updatedBy: input.updatedBy,
    }),
  );
}

export function useCatalogRestore() {
  return useInvalidatingMutation((input: { updatedBy: string }) =>
    api.post<{ restored: number; deactivated: number; removed: number }>(
      '/api/products/restore-demo',
      input,
    ),
  );
}

export function useProtocolDemo() {
  return useInvalidatingMutation(() => api.post<ProtocolDemoReport>('/api/protocol/demo'));
}

export function useGrowthPropose() {
  return useInvalidatingMutation(() => api.post<GrowthAgentReport>('/api/growth/proposals', {}));
}

export function useAttack() {
  return useInvalidatingMutation((name: string) =>
    api.post<import('@acsf/shared').AttackReport>(`/api/attacks/${name}`),
  );
}

export function useAdversarialRun() {
  return useInvalidatingMutation(() => api.post<AdversarialReport>('/api/adversarial/run'));
}

export function useFuzzRun() {
  return useInvalidatingMutation((input: FuzzRunInput) =>
    api.post<FuzzRunResponse>('/api/fuzzer/run', input),
  );
}

export function useCounterfactual() {
  return useInvalidatingMutation((input: CounterfactualRequest) =>
    api.post<CounterfactualResponse>('/api/counterfactual', input),
  );
}

export function useReconcile() {
  return useInvalidatingMutation((paymentId: string) =>
    api.post<ReconciliationReportDTO>(`/api/payments/${paymentId}/reconcile`),
  );
}

export function useProviderEvent() {
  return useInvalidatingMutation((input: { paymentId: string; event: string; state: string | null }) =>
    api.post<ProviderEventResult>(`/api/payments/${input.paymentId}/events`, {
      event: input.event,
      state: input.state,
    }),
  );
}

export function useApprove() {
  return useInvalidatingMutation(
    (input: { decisionId: string; approvedBy: string; outcome: 'approved' | 'rejected'; note?: string }) =>
      api.post<{ decision: { id: string; decision: Decision; approvedAt: string | null }; approval: unknown }>(
        `/api/decisions/${input.decisionId}/approve`,
        { approvedBy: input.approvedBy, outcome: input.outcome, note: input.note },
      ),
  );
}

export function usePolicyUpdate() {
  return useInvalidatingMutation((input: { updatedBy: string; patch: Record<string, unknown> }) =>
    api.put<{ policy: PolicyDTO }>('/api/policy', input),
  );
}