// apps/web/src/components/payments/ProviderEventForm.tsx
import { useState } from 'react';
import type { ProviderEventResult } from '../../types';
import { Badge, paymentTone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

const PRESETS = [
  { event: 'payment.captured', state: 'CAPTURED' },
  { event: 'payment.failed', state: 'FAILED' },
  { event: 'payment.authorized', state: 'AUTHORIZED' },
  { event: 'payment.captured', state: 'CAPTURED' },
] as const;

export function ProviderEventForm({
  onSubmit,
  loading,
  result,
}: {
  onSubmit: (event: string, state: string | null) => void;
  loading: boolean;
  result: ProviderEventResult | null;
}) {
  const [presetIndex, setPresetIndex] = useState(0);
  const preset = PRESETS[presetIndex] ?? PRESETS[0]!;

  return (
    <Card title="Provider Event (webhook simulation)" subtitle="Duplicate and out-of-order events are detected and never double-apply">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[10px] uppercase tracking-widest text-ink-faint">
          event
          <select
            value={presetIndex}
            onChange={(e) => setPresetIndex(Number(e.target.value))}
            className="mt-1 block rounded-xl border border-ink-line bg-canvas-mist px-2.5 py-1.5 outline-none transition-colors focus:border-brand-400 focus:bg-white font-mono text-xs text-ink"
          >
            {PRESETS.map((p, i) => (
              <option key={`${p.event}-${i}`} value={i}>
                {p.event} → {p.state}
              </option>
            ))}
          </select>
        </label>
        <Button loading={loading} onClick={() => onSubmit(preset.event, preset.state)}>
          Send event
        </Button>
      </div>
      {result !== null ? (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={paymentTone(result.state)}>{result.state}</Badge>
          {result.duplicate ? <Badge tone="review">DUPLICATE</Badge> : null}
          {result.ignored ? <Badge tone="neutral">IGNORED</Badge> : null}
          {!result.duplicate && !result.ignored && result.applied ? <Badge tone="allow">APPLIED</Badge> : null}
          <span className="text-ink-soft">{result.detail}</span>
        </p>
      ) : null}
      <p className="mt-2 text-[10px] text-ink-faint">
        Send the same captured event twice to watch DUPLICATE PAYMENT PREVENTED in the timeline.
      </p>
    </Card>
  );
}