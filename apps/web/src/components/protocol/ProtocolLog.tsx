// apps/web/src/components/protocol/ProtocolLog.tsx
import { timeOf } from '../../lib/format';
import { useProtocolStatus } from '../../hooks';
import { Badge, decisionTone } from '../ui/Badge';
import { Card } from '../ui/Card';
import { QueryError } from '../ui/QueryError';

function statusTone(status: string): 'allow' | 'block' | 'review' {
  if (status === 'ACCEPTED') return 'allow';
  if (status === 'DENIED') return 'block';
  return 'review';
}

export function ProtocolLog() {
  const status = useProtocolStatus();
  const requests = status.data?.recentRequests ?? [];
  return (
    <Card
      title="Live Protocol Log"
      subtitle={
        status.error !== null
          ? 'protocol status unavailable'
          : `${status.data?.totals.accepted ?? 0} accepted · ${status.data?.totals.denied ?? 0} denied · ${
              status.data?.totals.error ?? 0
            } error`
      }
    >
      <div className="max-h-72 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white">
            <tr className="text-left text-[10px] uppercase tracking-widest text-ink-faint">
              <th className="pb-2 pr-3">time</th>
              <th className="pb-2 pr-3">protocol</th>
              <th className="pb-2 pr-3">tool</th>
              <th className="pb-2 pr-3">agent</th>
              <th className="pb-2 pr-3">status</th>
              <th className="pb-2">summary</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id} className="border-t border-ink-line/70">
                <td className="py-1.5 pr-3 font-mono text-[10px] text-ink-faint">{timeOf(r.createdAt)}</td>
                <td className="py-1.5 pr-3 font-mono text-[10px] text-ink-soft">{r.protocol}</td>
                <td className="py-1.5 pr-3 font-mono text-[10px] text-ink-soft">{r.tool}</td>
                <td className="py-1.5 pr-3 font-mono text-[10px] text-ink-faint">{r.agentId}</td>
                <td className="py-1.5 pr-3">
                  <div className="flex gap-1">
                    <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                    {r.decision !== null ? <Badge tone={decisionTone(r.decision)}>{r.decision}</Badge> : null}
                  </div>
                </td>
                <td className="max-w-[280px] truncate py-1.5 text-ink-soft">{r.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {status.error !== null ? (
          <QueryError error={status.error} what="protocol activity" />
        ) : requests.length === 0 ? (
          <p className="py-3 text-xs text-ink-faint">No protocol activity yet.</p>
        ) : null}
      </div>
      <p className="mt-2 text-[10px] text-ink-faint">
        MCP server (stdio): <span className="font-mono">npm run mcp</span> — same tools, same gateway, same AuthorizationEngine.
      </p>
    </Card>
  );
}