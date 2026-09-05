// apps/web/src/components/audit/AuditExplorer.tsx
import { useState } from 'react';
import { AUDIT_EVENT_TYPES, type AuditEventDTO, type AuditEventType } from '@acsf/shared';
import { useAuditEvents, useChainStatus } from '../../hooks';
import { timeOf } from '../../lib/format';
import { Badge, decisionTone } from '../ui/Badge';
import { Card } from '../ui/Card';
import { QueryError } from '../ui/QueryError';

export function AuditExplorer() {
  const [eventType, setEventType] = useState<'ALL' | AuditEventType>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const events = useAuditEvents(eventType === 'ALL' ? undefined : eventType);
  const chain = useChainStatus();
  const rows: AuditEventDTO[] = events.data?.events ?? [];

  return (
    <Card
      title="Audit Explorer"
      subtitle="SHA-256 hash-chained, append-only — tampering is detectable"
      right={
        <Badge tone={chain.data?.valid === true ? 'allow' : chain.data?.valid === false ? 'block' : 'neutral'}>
          {chain.error !== null
            ? 'chain status unavailable'
            : chain.data?.valid === true
              ? `chain valid · ${chain.data.eventCount} events`
              : chain.data?.message ?? '…'}
        </Badge>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value as 'ALL' | AuditEventType)}
          className="rounded-xl border border-ink-line bg-canvas-mist px-2.5 py-1.5 outline-none transition-colors focus:border-brand-400 focus:bg-white font-mono text-xs text-ink"
        >
          <option value="ALL">ALL EVENTS</option>
          {AUDIT_EVENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <span className="text-[10px] text-ink-faint">
          {/* The query asks for 200; the chain badge carries the true total. */}
          showing {rows.length}
          {chain.data !== undefined && chain.data.eventCount > rows.length ? ` of ${chain.data.eventCount}` : ''} events
          (latest first)
        </span>
      </div>
      <div className="max-h-[640px] overflow-y-auto">
        {events.error !== null ? (
          <QueryError error={events.error} what="audit events" />
        ) : rows.length === 0 ? (
          <p className="py-3 text-xs text-ink-faint">No audit events yet.</p>
        ) : (
          rows.map((event) => {
            const expanded = expandedId === event.eventId;
            return (
              <div key={event.eventId} className="border-b border-ink-line/70">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : event.eventId)}
                  className="flex w-full items-center gap-2 px-1 py-2 text-left text-xs hover:bg-canvas-mist"
                >
                  <span className="w-10 font-mono text-[10px] text-ink-faint">#{event.sequence}</span>
                  <span className="w-16 font-mono text-[10px] text-ink-faint">{timeOf(event.timestamp)}</span>
                  <span className="w-36 truncate font-mono text-[10px] text-ink-soft">{event.actor}</span>
                  <span className="w-40 font-mono text-[10px] text-brand-600">{event.eventType}</span>
                  <span className="flex-1 truncate text-ink-soft">{event.action ?? '—'}</span>
                  {event.decision !== null ? (
                    <Badge tone={decisionTone(event.decision)}>{event.decision}</Badge>
                  ) : null}
                  <span className="font-mono text-[10px] text-ink-faint">{event.eventHash.slice(0, 8)}…</span>
                </button>
                {expanded ? (
                  <div className="space-y-1 px-4 pb-3 text-[11px] text-ink-soft">
                    <p className="font-mono">event_id: {event.eventId}</p>
                    <p className="font-mono">input_hash: {event.inputHash}</p>
                    <p className="font-mono">prev: {event.previousEventHash ?? '(genesis)'}</p>
                    <p className="font-mono">hash: {event.eventHash}</p>
                    <p className="font-mono">policy_version: {event.policyVersion ?? '—'}</p>
                    {event.reason !== null ? <p>reason: {event.reason}</p> : null}
                    {event.payload !== null ? (
                      <pre className="mt-1 max-h-48 overflow-auto rounded-xl bg-ink p-2.5 font-mono text-[10px] leading-relaxed text-canvas-soft">
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}