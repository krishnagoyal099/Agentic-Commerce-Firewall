// apps/web/src/components/firewall/PolicyEditorPanel.tsx
import { useState } from 'react';
import { errMessage } from '../../api/client';
import { usePolicy, usePolicyUpdate } from '../../hooks';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { QueryError } from '../ui/QueryError';

export function PolicyEditorPanel() {
  const policy = usePolicy();
  const update = usePolicyUpdate();
  const active = policy.data?.active ?? null;
  const [maxOrderRupees, setMaxOrderRupees] = useState('');
  const [maxDiscountRupees, setMaxDiscountRupees] = useState('');
  const [dailyBudgetRupees, setDailyBudgetRupees] = useState('');

  const submit = (): void => {
    const patch: Record<string, unknown> = {};
    const order = Number(maxOrderRupees);
    const discount = Number(maxDiscountRupees);
    const budget = Number(dailyBudgetRupees);
    if (maxOrderRupees !== '' && Number.isInteger(order)) patch.maxOrderAmountRupees = order;
    if (maxDiscountRupees !== '' && Number.isInteger(discount)) patch.maxDiscountRupees = discount;
    if (dailyBudgetRupees !== '' && Number.isInteger(budget)) patch.dailyBudgetRupees = budget;
    if (Object.keys(patch).length === 0) return;
    update.mutate({ updatedBy: 'demo-user', patch });
  };

  return (
    <Card
      title="Merchant Policy"
      subtitle="Edits validate with Zod, create a new version, and are audit-logged — agents can never edit policy"
      right={active !== null ? <Badge tone="accent">v{active.version}</Badge> : null}
    >
      {active !== null ? (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2 font-mono text-[11px] text-ink-soft">
            <span>order ≤ ₹{(active.maxOrderAmountPaise / 100).toLocaleString('en-IN')}</span>
            <span>discount ≤ ₹{(active.maxDiscountPaise / 100).toLocaleString('en-IN')}</span>
            <span>budget ₹{(active.dailyBudgetPaise / 100).toLocaleString('en-IN')}/day</span>
            <span>TTL {active.authorizationTtlMinutes}m</span>
            <span>margin ≥ {active.minimumMarginPercent}%</span>
            <span>
              drift {'>'} {active.requireApprovalAboveDrift.toFixed(2)} review / {'>'}{' '}
              {active.blockAboveDrift.toFixed(2)} block
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {[
              { label: 'max order ₹', value: maxOrderRupees, set: setMaxOrderRupees, placeholder: '10000' },
              { label: 'max discount ₹', value: maxDiscountRupees, set: setMaxDiscountRupees, placeholder: '500' },
              { label: 'daily budget ₹', value: dailyBudgetRupees, set: setDailyBudgetRupees, placeholder: '50000' },
            ].map((field) => (
              <label key={field.label} className="text-[10px] uppercase tracking-widest text-ink-faint">
                {field.label}
                <input
                  value={field.value}
                  placeholder={field.placeholder}
                  onChange={(e) => field.set(e.target.value)}
                  className="mt-1 w-28 rounded-xl border border-ink-line bg-canvas-mist px-2.5 py-1.5 outline-none transition-colors focus:border-brand-400 focus:bg-white font-mono text-xs text-ink"
                />
              </label>
            ))}
            <Button onClick={submit} loading={update.isPending}>
              Update policy (as demo-user)
            </Button>
          </div>
          {update.error !== null ? <p className="text-xs text-block">{errMessage(update.error)}</p> : null}
          {update.data !== undefined ? (
            <p className="text-xs text-allow">
              Policy updated to v{update.data.policy.version}; every prior decision keeps the version it used.
            </p>
          ) : null}
          <p className="text-[10px] text-ink-faint">
            {policy.data?.versions.length ?? 0} version(s) retained — history is never rewritten.
          </p>
        </div>
      ) : policy.error !== null ? (
        // Was an unconditional "Loading policy…", which never resolved when the
        // request failed — a permanent spinner with no error and no retry.
        <QueryError error={policy.error} what="the merchant policy" />
      ) : (
        <p className="text-xs text-ink-faint">Loading policy…</p>
      )}
    </Card>
  );
}