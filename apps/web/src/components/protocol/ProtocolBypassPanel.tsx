// apps/web/src/components/protocol/ProtocolBypassPanel.tsx
import { ATTACK_INFO, type AttackReport } from '@acsf/shared';
import { errMessage } from '../../api/client';
import { useAttack } from '../../hooks';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

export function ProtocolBypassPanel() {
  const attack = useAttack();
  const report: AttackReport | null = attack.data ?? null;
  return (
    <Card title="Protocol Bypass Attempt" subtitle="An MCP request tries to invoke a privileged tool (refund.create)">
      <Button
        variant="danger"
        loading={attack.isPending}
        onClick={() => attack.mutate('protocol_bypass')}
      >
        Attempt protocol bypass
      </Button>
      {attack.error !== null ? <p className="mt-3 text-xs text-block">{errMessage(attack.error)}</p> : null}
      {report !== null ? (
        <div className="mt-3 space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <Badge tone="block">{report.decision}</Badge>
            <span className="text-ink-soft">{ATTACK_INFO.protocol_bypass.description}</span>
          </div>
          <ol className="space-y-1 text-ink-soft">
            {report.steps.map((step, i) => (
              <li key={i} className="flex gap-2">
                <span className="font-mono text-ink-faint">{i + 1}.</span>
                <span>
                  <span className="text-ink">{step.label}</span> — {step.detail}
                </span>
              </li>
            ))}
          </ol>
          <p className="text-[10px] text-ink-faint">
            Protocol request accepted → capability validation → capability denied → payment/refund layer never reached.
          </p>
        </div>
      ) : null}
    </Card>
  );
}