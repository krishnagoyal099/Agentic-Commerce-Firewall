// apps/web/src/components/attacks/AttackLab.tsx
import { ATTACKS, ATTACK_INFO, type AttackCategory, type AttackReport } from '@acsf/shared';
import { errMessage } from '../../api/client';
import { useAttack } from '../../hooks';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { AttackReportView } from './AttackReportView';

function categoryTone(category: AttackCategory): 'accent' | 'review' | 'block' {
  if (category === 'protocol') return 'accent';
  if (category === 'payment') return 'review';
  return 'block';
}

export function AttackLab() {
  const attack = useAttack();
  const report: AttackReport | null = attack.data ?? null;
  const running = attack.isPending ? (attack.variables ?? null) : null;

  return (
    <div className="space-y-6">
      <Card title="Attack Lab" subtitle="Every attack executes real application logic — the firewall decides deterministically">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {ATTACKS.map((name) => {
            const info = ATTACK_INFO[name];
            return (
              <div
                key={name}
                className={`flex flex-col justify-between rounded-xl border p-3 transition-colors ${
                  running === name
                    ? 'border-brand-400 bg-brand-50 shadow-lift'
                    : 'border-ink-line bg-white hover:border-brand-200 hover:shadow-card'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold text-ink">{info.title}</h3>
                    <Badge tone={categoryTone(info.category)}>{info.category}</Badge>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-ink-soft">{info.description}</p>
                </div>
                <div className="mt-3">
                  {/* All ten cards share one mutation, so a second launch while
                      one was in flight ran both attacks against the live backend
                      and silently discarded the first one's report. */}
                  <Button
                    variant="danger"
                    loading={running === name}
                    disabled={attack.isPending && running !== name}
                    onClick={() => attack.mutate(name)}
                  >
                    Launch
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        {attack.error !== null ? <p className="mt-3 text-xs text-block">{errMessage(attack.error)}</p> : null}
      </Card>
      {report !== null ? <AttackReportView report={report} /> : null}
    </div>
  );
}