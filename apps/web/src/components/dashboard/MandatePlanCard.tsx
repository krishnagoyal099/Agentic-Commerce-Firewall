// apps/web/src/components/dashboard/MandatePlanCard.tsx
import { formatINR, type MandatePlan } from '@acsf/shared';
import { Badge } from '../ui/Badge';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/10 px-3 py-2 ring-1 ring-inset ring-white/15">
      <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-brand-100">{label}</p>
      <p className="mt-0.5 text-[13px] font-semibold text-white">{value}</p>
    </div>
  );
}

/**
 * The mandate the user is ABOUT to grant. Nothing here is authority yet — it is
 * a draft the firewall will validate, and the source badge says plainly whether
 * a model or the keyword parser wrote it.
 */
export function MandatePlanCard({
  plan,
  llm,
  categoryLabels,
}: {
  plan: MandatePlan;
  llm: { used: boolean; model: string | null; error: string | null } | null;
  categoryLabels: Record<string, string>;
}) {
  const unmatched = plan.allowedCategories.length === 0;
  return (
    <div className="w-full max-w-[360px] rounded-2xl bg-white/10 p-4 ring-1 ring-inset ring-white/20">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-white">
          Proposed mandate
        </p>
        <Badge tone="onDark">
          {plan.source === 'llm' ? `LLM · ${llm?.model ?? 'model'}` : 'Keyword parser'}
        </Badge>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Field label="Ceiling" value={`₹${plan.maxAmountRupees.toLocaleString('en-IN')}`} />
        <Field label="Valid for" value={`${plan.ttlHours}h`} />
      </div>

      <div className="mt-2 rounded-xl bg-white/10 px-3 py-2 ring-1 ring-inset ring-white/15">
        <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-brand-100">
          Allowed categories
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {unmatched ? (
            <span className="text-[12px] font-semibold text-white">none matched</span>
          ) : (
            plan.allowedCategories.map((category) => (
              <span
                key={category}
                className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-brand-700"
              >
                {categoryLabels[category] ?? category}
              </span>
            ))
          )}
          <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold text-white">
            upsell {plan.allowUpsell ? 'allowed' : 'denied'}
          </span>
        </div>
      </div>

      {plan.matches.length > 0 ? (
        <div className="mt-2 rounded-xl bg-white/10 px-3 py-2 ring-1 ring-inset ring-white/15">
          <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-brand-100">
            Catalog matches
          </p>
          <ul className="mt-1 space-y-0.5">
            {plan.matches.slice(0, 3).map((product) => (
              <li key={product.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="truncate text-white">{product.name}</span>
                <span className="shrink-0 font-mono text-brand-100">{formatINR(product.pricePaise)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-2.5 text-[11px] leading-relaxed text-brand-100">{plan.rationale}</p>

      {plan.warnings.map((warning) => (
        <p
          key={warning}
          className="mt-2 rounded-xl bg-white px-3 py-2 text-[11px] font-medium leading-relaxed text-brand-700"
        >
          {warning}
        </p>
      ))}

      {llm !== null && !llm.used && llm.error !== null ? (
        <p className="mt-2 font-mono text-[10px] text-brand-100">llm fallback: {llm.error}</p>
      ) : null}
    </div>
  );
}
