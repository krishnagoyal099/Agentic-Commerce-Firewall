// apps/web/src/pages/GrowthPage.tsx
import { errMessage } from '../api/client';
import { GrowthPanel } from '../components/growth/GrowthPanel';
import { useGrowthAnalytics, useGrowthOpportunities, useGrowthPropose } from '../hooks';

export function GrowthPage() {
  const analytics = useGrowthAnalytics();
  const opportunities = useGrowthOpportunities();
  const propose = useGrowthPropose();
  return (
    <GrowthPanel
      analytics={analytics.data?.analytics ?? []}
      opportunities={opportunities.data?.opportunities ?? []}
      onPropose={() => propose.mutate()}
      proposing={propose.isPending}
      report={propose.data ?? null}
      // A failed analytics/opportunities fetch used to render as "No completed
      // transactions yet — run START DEMO", i.e. a health claim the page had
      // not verified. Surface the load failure instead.
      error={
        propose.error !== null
          ? errMessage(propose.error)
          : analytics.error !== null
            ? `Could not load growth analytics: ${errMessage(analytics.error)} — this is a load failure, not an empty result.`
            : opportunities.error !== null
              ? `Could not load growth opportunities: ${errMessage(opportunities.error)} — this is a load failure, not an empty result.`
              : null
      }
    />
  );
}