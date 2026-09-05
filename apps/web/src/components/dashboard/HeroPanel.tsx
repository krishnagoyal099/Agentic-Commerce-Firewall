// apps/web/src/components/dashboard/HeroPanel.tsx
import { useMemo, useState } from 'react';
import { errMessage } from '../../api/client';
import { useIntentOptions, useIntentPlan, type DemoRunOptions } from '../../hooks';
import { Button } from '../ui/Button';
import { MandatePlanCard } from './MandatePlanCard';

const STACK = [
  { label: 'PAYMENT', width: 'w-[78%]', note: 'guarded execution' },
  { label: 'CAPABILITY', width: 'w-[88%]', note: 'fail closed' },
  { label: 'AUTHORITY DRIFT', width: 'w-[82%]', note: 'deterministic score' },
  { label: 'MERCHANT POLICY', width: 'w-[94%]', note: 'versioned' },
  { label: 'USER MANDATE', width: 'w-full', note: 'your intent' },
] as const;

function AuthorityStack() {
  return (
    <div className="flex w-full max-w-[340px] flex-col items-center gap-2">
      <span className="mb-1 rounded-full bg-white px-3 py-1 text-[10px] font-extrabold uppercase tracking-[0.2em] text-brand-700">
        Agent stands here
      </span>
      {STACK.map((block, i) => (
        <div
          key={block.label}
          className={`${block.width} rounded-2xl bg-white/10 px-4 py-3 ring-1 ring-inset ring-white/25 backdrop-blur-[1px]`}
          style={{ transform: `rotate(${(i % 2 === 0 ? -1 : 1) * 0.6}deg)` }}
        >
          <p className="font-mono text-[10px] font-bold tracking-widest text-white">{block.label}</p>
          <p className="text-[10px] text-brand-100">{block.note}</p>
        </div>
      ))}
      <div className="mt-1 h-1 w-[108%] rounded-full bg-white/25" />
    </div>
  );
}

export function HeroPanel({
  onStart,
  onReset,
  busy,
  error,
}: {
  onStart: (options: DemoRunOptions) => void;
  onReset: (options: DemoRunOptions) => void;
  busy: boolean;
  error: string | null;
}) {
  const [intent, setIntent] = useState('');
  const [budget, setBudget] = useState('');
  const options = useIntentOptions();
  const planner = useIntentPlan();

  const categoryLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const category of options.data?.categories ?? []) map[category.id] = category.label;
    return map;
  }, [options.data]);

  const trimmed = intent.trim();
  const budgetRupees = /^\d+$/.test(budget.trim()) ? Number(budget.trim()) : undefined;
  // The ceiling applies even when no intent is typed (the run then uses the
  // demo default intent). Folding it into the `trimmed.length >= 5` branch
  // silently discarded a filled-in Ceiling box and ran on the ₹8,000 default.
  const runOptions: DemoRunOptions = {
    ...(trimmed.length >= 5 ? { intent: trimmed } : {}),
    ...(budgetRupees !== undefined ? { maxAmountRupees: budgetRupees } : {}),
  };

  const plan = planner.data?.plan ?? null;
  // Staleness must cover EVERY input the plan depends on. Keyed on the intent
  // alone, changing only the ceiling left the preview card displaying the old
  // one while the run granted the new one.
  const planIsStale =
    plan !== null &&
    (plan.intent !== trimmed || (budgetRupees !== undefined && plan.maxAmountRupees !== budgetRupees));
  const unmatched = plan !== null && !planIsStale && plan.allowedCategories.length === 0;

  const preview = (): void => {
    if (trimmed.length < 5) return;
    planner.mutate({ intent: trimmed, ...(budgetRupees !== undefined ? { maxAmountRupees: budgetRupees } : {}) });
  };

  return (
    <section className="hero-grid panel-dark relative overflow-hidden rounded-[28px] bg-brand-500 shadow-panel">
      <div className="grid gap-8 p-7 sm:p-10 lg:grid-cols-[1fr_auto] lg:items-start">
        <div className="max-w-2xl">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-[10px] font-extrabold uppercase tracking-[0.22em] text-white ring-1 ring-inset ring-white/25">
            Razorpay Hackathon · Agentic Commerce
          </span>
          <h1 className="display mt-5 text-5xl text-white sm:text-6xl">
            <span className="font-extrabold">Bounded</span> <span className="font-light">Autonomy</span>
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-white">
            <span className="font-bold">Tell the agent what you want.</span>{' '}
            <span className="text-brand-100">
              Your words become a mandate — a spending ceiling and a set of categories. The agent
              proposes; the deterministic firewall decides what actually reaches money.
            </span>
          </p>

          <div className="mt-6 rounded-2xl bg-white/10 p-4 ring-1 ring-inset ring-white/20">
            <label className="block text-[10px] font-extrabold uppercase tracking-[0.2em] text-white">
              Your intent
              <textarea
                value={intent}
                rows={2}
                maxLength={500}
                placeholder="e.g. I need running shoes for my marathon under ₹8,000"
                onChange={(e) => setIntent(e.target.value)}
                className="mt-2 w-full resize-none rounded-xl border-0 bg-white px-3 py-2.5 text-[13px] font-medium tracking-normal text-ink outline-none ring-1 ring-inset ring-white/40 placeholder:text-ink-faint focus:ring-2 focus:ring-white"
              />
            </label>

            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-white">
                Ceiling ₹
                <input
                  value={budget}
                  inputMode="numeric"
                  placeholder="from intent"
                  onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ''))}
                  className="mt-2 block w-32 rounded-xl border-0 bg-white px-3 py-2 font-mono text-xs tracking-normal text-ink outline-none ring-1 ring-inset ring-white/40 placeholder:text-ink-faint focus:ring-2 focus:ring-white"
                />
              </label>
              <button
                type="button"
                disabled={trimmed.length < 5 || planner.isPending}
                onClick={preview}
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white ring-1 ring-inset ring-white/35 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {planner.isPending ? 'Reading intent…' : 'Preview mandate'}
              </button>
              <Button
                variant="onDark"
                onClick={() => onStart(runOptions)}
                loading={busy}
                disabled={unmatched}
              >
                {trimmed.length >= 5 ? 'RUN MY INTENT' : 'START DEMO'}
              </Button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onReset(runOptions)}
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white ring-1 ring-inset ring-white/35 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                RESET
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-100">Try</span>
              {(options.data?.presets ?? []).map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setIntent(preset.intent);
                    setBudget('');
                    planner.reset();
                  }}
                  className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-white/25"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {options.data?.llm.enabled === false ? (
              <p className="mt-3 font-mono text-[10px] text-brand-100">
                LLM parsing off — using the deterministic keyword parser.
              </p>
            ) : null}
          </div>

          <p className="mt-5 font-mono text-xs font-bold tracking-[0.28em] text-white">
            AI PROPOSES · POLICY DECIDES
          </p>

          {planner.error !== null ? (
            <p className="mt-4 inline-block rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-brand-700">
              {errMessage(planner.error)}
            </p>
          ) : null}
          {error !== null ? (
            <p className="mt-4 inline-block rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-brand-700">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex justify-center lg:justify-end">
          {plan !== null && !planIsStale ? (
            <MandatePlanCard
              plan={plan}
              llm={planner.data?.llm ?? null}
              categoryLabels={categoryLabels}
            />
          ) : (
            <AuthorityStack />
          )}
        </div>
      </div>
    </section>
  );
}
