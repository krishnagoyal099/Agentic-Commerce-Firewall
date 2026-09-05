// apps/web/src/components/firewall/DriftGraph.tsx
import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DecisionSummaryDTO } from '@acsf/shared';
import { useDecisionsBySession, usePolicy } from '../../hooks';
import { Card } from '../ui/Card';
import { Spinner } from '../ui/Spinner';

export function DriftGraph({ sessionId }: { sessionId: string | null }) {
  const sessionDecisions = useDecisionsBySession(sessionId);
  const policy = usePolicy();

  const data = useMemo(() => {
    const rows: DecisionSummaryDTO[] = sessionDecisions.data?.decisions ?? [];
    return rows
      .filter((d) => d.driftOverall !== null)
      .map((d, i) => ({ i: i + 1, overall: d.driftOverall ?? 0, summary: d.actionSummary }));
  }, [sessionDecisions.data]);

  const approval = policy.data?.active?.requireApprovalAboveDrift ?? 0.7;
  const block = policy.data?.active?.blockAboveDrift ?? 0.9;

  return (
    <Card
      title="Authority Drift"
      subtitle={
        sessionId !== null
          ? `session ${sessionId} — action sequence`
          : 'select a decision with an active session'
      }
    >
      {sessionId !== null && sessionDecisions.isLoading ? (
        <div className="flex h-[220px] items-center justify-center text-ink-faint">
          <Spinner />
        </div>
      ) : data.length === 0 ? (
        <div className="flex h-[220px] items-center justify-center text-xs text-ink-faint">
          {sessionId === null
            ? 'This decision has no drift session — the firewall scores drift only for actions that clear every other rule.'
            : 'No drift-scored actions in this session yet.'}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
            <CartesianGrid stroke="#D3E2F6" />
            <XAxis dataKey="i" tick={{ fill: '#7987A6', fontSize: 10 }} />
            <YAxis domain={[0, 1]} ticks={[0, 0.4, 0.7, 0.9, 1]} tick={{ fill: '#7987A6', fontSize: 10 }} />
            <Tooltip
              contentStyle={{
                background: '#FFFFFF',
                color: '#0A1633',
                border: '1px solid #D3E2F6',
                boxShadow: '0 8px 24px -12px rgba(10,22,51,0.25)',
                fontSize: 12,
                borderRadius: 8,
              }}
              formatter={(value: unknown) => [`drift ${Number(value).toFixed(2)}`, 'overall']}
              labelFormatter={(label: unknown) => `action #${String(label)}`}
            />
            <ReferenceLine y={approval} stroke="#B45309" strokeDasharray="4 4" />
            <ReferenceLine y={block} stroke="#DC2626" strokeDasharray="4 4" />
            <Line
              type="monotone"
              dataKey="overall"
              stroke="#3D57F5"
              strokeWidth={2}
              dot={{ r: 3, fill: '#3D57F5' }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
      <p className="mt-2 text-[10px] text-ink-faint">
        amber = approval threshold ({approval.toFixed(2)}) · red = block threshold ({block.toFixed(2)}) · deterministic engine, never an LLM
      </p>
    </Card>
  );
}