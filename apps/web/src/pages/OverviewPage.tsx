// apps/web/src/pages/OverviewPage.tsx
import { errMessage } from '../api/client';
import { AgenticFlowPanel } from '../components/dashboard/AgenticFlowPanel';
import { DemoResultView } from '../components/dashboard/DemoResultView';
import { FinalStatement } from '../components/dashboard/FinalStatement';
import { HeroPanel } from '../components/dashboard/HeroPanel';
import { MetricsGrid } from '../components/dashboard/MetricsGrid';
import { useDemoReset, useDemoStart, useMetrics } from '../hooks';

export function OverviewPage() {
  const metrics = useMetrics();
  const startDemo = useDemoStart();
  const resetDemo = useDemoReset();

  return (
    <div className="space-y-6">
      <HeroPanel
        onStart={(options) => {
          resetDemo.reset();
          startDemo.mutate(options);
        }}
        onReset={(options) => {
          // Clears the previous run's report and error: RESET wipes the
          // decisions, orders and payments that report describes, so leaving it
          // on screen contradicts the freshly-zeroed metrics right below it.
          startDemo.reset();
          resetDemo.mutate(options);
        }}
        busy={startDemo.isPending || resetDemo.isPending}
        error={
          startDemo.error !== null
            ? errMessage(startDemo.error)
            : resetDemo.error !== null
              ? errMessage(resetDemo.error)
              : null
        }
      />
      {startDemo.data !== undefined ? <DemoResultView report={startDemo.data} /> : null}
      {metrics.data !== undefined ? (
        <MetricsGrid snapshot={metrics.data} />
      ) : metrics.error !== null ? (
        <p className="text-xs text-block">{errMessage(metrics.error)} — is the API running on :3001?</p>
      ) : null}
      <AgenticFlowPanel snapshot={metrics.data ?? null} />
      <FinalStatement />
    </div>
  );
}