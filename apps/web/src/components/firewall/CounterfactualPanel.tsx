// apps/web/src/components/firewall/CounterfactualPanel.tsx
import { useState } from 'react';
import { formatINR, rupeesToPaise } from '@acsf/shared';
import { errMessage } from '../../api/client';
import { useCounterfactual } from '../../hooks';
import type { CounterfactualParameter } from '../../types';
import { Badge, decisionTone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

const PARAMS: Array<{ value: CounterfactualParameter; label: string; hint: string; defaults: string }> = [
  { value: 'discountPaise', label: 'Discount', hint: '₹ against the ₹500 merchant cap', defaults: '499, 500, 501, 2000' },
  { value: 'amountPaise', label: 'Order amount', hint: '₹ against the ₹8,000 mandate cap', defaults: '7999, 8000, 8001' },
  { value: 'mandateMaxPaise', label: 'Mandate cap', hint: '₹ user authority ceiling', defaults: '8000, 7000, 12000' },
];

export function CounterfactualPanel() {
  const [parameter, setParameter] = useState<CounterfactualParameter>('discountPaise');
  const [valuesText, setValuesText] = useState('499, 500, 501, 2000');
  const mutation = useCounterfactual();

  const [inputError, setInputError] = useState<string | null>(null);

  const run = (): void => {
    // Empty tokens used to survive: Number('') is 0, so a trailing comma added
    // a bogus ₹0 scenario and an empty field submitted [0] instead of doing
    // nothing. Bounds match the server's (max 12 values, ≤ ₹10,00,000 each).
    const tokens = valuesText.split(',').map((token) => token.trim()).filter((token) => token.length > 0);
    if (tokens.length === 0) {
      setInputError('Enter at least one rupee value, separated by commas.');
      return;
    }
    if (tokens.some((token) => !Number.isFinite(Number(token)) || Number(token) < 0)) {
      setInputError('Every value must be a non-negative number.');
      return;
    }
    if (tokens.length > 12) {
      setInputError(`The engine evaluates at most 12 scenarios; you entered ${tokens.length}.`);
      return;
    }
    const values = tokens.map((token) => rupeesToPaise(Number(token)));
    if (values.some((paise) => paise > 100_000_000)) {
      setInputError('Each value must be ₹10,00,000 or less.');
      return;
    }
    setInputError(null);
    mutation.mutate({ parameter, values });
  };

  return (
    <Card title="What Would Happen If…?" subtitle="Counterfactuals call the same AuthorizationEngine; no real financial state is mutated">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-ink-soft">
          <span className="mb-1 block text-[10px] uppercase tracking-widest text-ink-faint">Parameter</span>
          <select
            value={parameter}
            onChange={(e) => {
              const next = e.target.value as CounterfactualParameter;
              setParameter(next);
              const preset = PARAMS.find((p) => p.value === next);
              if (preset !== undefined) setValuesText(preset.defaults);
            }}
            className="rounded-xl border border-ink-line bg-canvas-mist px-2.5 py-1.5 outline-none transition-colors focus:border-brand-400 focus:bg-white text-xs text-ink"
          >
            {PARAMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label} — {p.hint}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1 text-xs text-ink-soft">
          <span className="mb-1 block text-[10px] uppercase tracking-widest text-ink-faint">Values (₹, comma-separated)</span>
          <input
            value={valuesText}
            onChange={(e) => setValuesText(e.target.value)}
            className="w-full rounded-xl border border-ink-line bg-canvas-mist px-2.5 py-1.5 outline-none transition-colors focus:border-brand-400 focus:bg-white font-mono text-xs text-ink"
          />
        </label>
        <Button variant="primary" onClick={run} loading={mutation.isPending}>
          Evaluate
        </Button>
      </div>

      {inputError !== null ? <p className="mt-3 text-xs text-block">{inputError}</p> : null}
      {mutation.error !== null ? (
        <p className="mt-3 text-xs text-block">{errMessage(mutation.error)}</p>
      ) : null}

      {mutation.data !== undefined ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-ink-faint">
                <th className="pb-2 pr-4">Value</th>
                <th className="pb-2 pr-4">Decision</th>
                <th className="pb-2 pr-4">Drift</th>
                <th className="pb-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {mutation.data.results.map((r, i) => (
                <tr key={i} className="border-t border-ink-line/70">
                  <td className="py-2 pr-4 font-mono text-ink">{formatINR(r.value)}</td>
                  <td className="py-2 pr-4">
                    <Badge tone={decisionTone(r.decision)}>{r.decision}</Badge>
                  </td>
                  <td className="py-2 pr-4 font-mono text-ink-soft">
                    {r.drift !== null ? r.drift.toFixed(2) : '—'}
                  </td>
                  <td className="py-2 text-ink-soft">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-ink-faint">{mutation.data.note}</p>
        </div>
      ) : null}
    </Card>
  );
}