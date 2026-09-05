// apps/web/src/components/attacks/FuzzPanel.tsx
import { useState } from 'react';
import { errMessage } from '../../api/client';
import { useFuzzRun } from '../../hooks';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { StatCard } from '../ui/StatCard';

export function FuzzPanel() {
  const [cases, setCases] = useState('5000');
  const [seed, setSeed] = useState('1337');
  const [maxSequenceLength, setMaxSequenceLength] = useState('6');
  const mutation = useFuzzRun();

  const [inputError, setInputError] = useState<string | null>(null);

  const run = (): void => {
    const parsedCases = Number(cases);
    const parsedSeed = Number(seed);
    const parsedSeq = Number(maxSequenceLength);
    // Bounds mirror the server's, and a bad value now SAYS so instead of the
    // button doing nothing (clearing the field even rendered "Run 0 Fuzz Tests").
    if (!Number.isInteger(parsedCases) || parsedCases < 1 || parsedCases > 5_000) {
      setInputError('Cases must be a whole number between 1 and 5,000. Run larger sweeps from the CLI: npm run fuzz.');
      return;
    }
    if (!Number.isInteger(parsedSeed) || parsedSeed < 0 || parsedSeed > 2_147_483_647) {
      setInputError('Seed must be a whole number between 0 and 2,147,483,647.');
      return;
    }
    if (!Number.isInteger(parsedSeq) || parsedSeq < 1 || parsedSeq > 12) {
      setInputError('Sequence length must be a whole number between 1 and 12.');
      return;
    }
    setInputError(null);
    mutation.mutate({ cases: parsedCases, seed: parsedSeed, maxSequenceLength: parsedSeq });
  };

  const stats = mutation.data?.run.stats ?? null;

  return (
    <Card
      title="Firewall Security Test — Fuzzer"
      subtitle="Seeded, deterministic, sequence-aware; every case runs the real AuthorizationEngine"
      right={
        mutation.data !== undefined ? (
          <Badge tone="accent">
            {mutation.data.run.durationMs.toLocaleString('en-IN')} ms · seed {mutation.data.run.seed}
          </Badge>
        ) : null
      }
    >
      <div className="flex flex-wrap items-end gap-2">
        {[
          { label: 'cases', value: cases, set: setCases, width: 'w-24' },
          { label: 'seed', value: seed, set: setSeed, width: 'w-24' },
          { label: 'max sequence length', value: maxSequenceLength, set: setMaxSequenceLength, width: 'w-24' },
        ].map((field) => (
          <label key={field.label} className="text-[10px] uppercase tracking-widest text-ink-faint">
            {field.label}
            <input
              value={field.value}
              onChange={(e) => field.set(e.target.value)}
              className={`mt-1 ${field.width} rounded-xl border border-ink-line bg-canvas-mist px-2.5 py-1.5 outline-none transition-colors focus:border-brand-400 focus:bg-white font-mono text-xs text-ink`}
            />
          </label>
        ))}
        <Button variant="primary" onClick={run} loading={mutation.isPending}>
          Run {Number.isFinite(Number(cases)) ? Number(cases).toLocaleString('en-IN') : ''} Fuzz Tests
        </Button>
      </div>

      {inputError !== null ? <p className="mt-3 text-xs text-block">{inputError}</p> : null}
      {mutation.error !== null ? (
        <p className="mt-3 text-xs text-block">{errMessage(mutation.error)}</p>
      ) : null}

      {stats !== null ? (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <StatCard label="Cases tested" value={stats.totalCases.toLocaleString('en-IN')} />
            <StatCard label="Blocked" value={stats.blocked} tone="block" />
            <StatCard label="Reauthorized" value={stats.reauthorized} tone="review" />
            <StatCard label="Human approval" value={stats.humanApproval} tone="review" />
            <StatCard label="Allowed" value={stats.allowed} tone="allow" />
            <StatCard label="Policy violations" value={stats.policyViolations} />
            <StatCard label="Bypasses" value={stats.bypasses} tone={stats.bypasses > 0 ? 'block' : 'allow'} />
            <StatCard label="Failures" value={stats.failures} tone={stats.failures > 0 ? 'block' : 'allow'} />
          </div>
          {mutation.data !== undefined && mutation.data.bypasses.length > 0 ? (
            <div className="rounded-xl border border-block/25 bg-block/10 p-3">
              <p className="text-xs font-semibold text-block">BYPASSES DETECTED — investigate:</p>
              <ul className="mt-1 space-y-1 text-[11px] text-ink-soft">
                {mutation.data.bypasses.slice(0, 20).map((b) => (
                  <li key={b.caseIndex} className="font-mono">
                    case {b.caseIndex}: {b.description} → {b.outcome} ({b.reason})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {mutation.data !== undefined ? (
            <p className="text-[10px] text-ink-faint">{mutation.data.note}</p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}