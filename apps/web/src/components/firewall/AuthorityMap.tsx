// apps/web/src/components/firewall/AuthorityMap.tsx  (FULL FINAL)
import { formatINR, type PolicyDTO } from '@acsf/shared';
import type { AgentInfo } from '../../types';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';

function Branch({ label, items }: { label: string; items: Array<{ text: string; allowed: boolean }> }) {
  return (
    <div className="rounded-xl border border-ink-line bg-canvas-mist p-3">
      <p className="font-mono text-xs tracking-wide text-ink">{label}</p>
      <ul className="mt-2 space-y-1 pl-3 text-xs">
        {items.map((item) => (
          <li key={item.text} className="flex items-center gap-2">
            <span className={item.allowed ? 'text-allow' : 'text-block'}>{item.allowed ? '├─' : '├─ ✕'}</span>
            <span className="text-ink-soft">{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AuthorityMap({ policy, agents }: { policy: PolicyDTO | null; agents: AgentInfo[] }) {
  // With no policy loaded this used to fall back to `false` for every
  // capability, which drew "✕ CART" and "✕ UPSELL" — asserting the merchant
  // denies things it actually allows. An unknown policy is not a denial.
  if (policy === null) {
    return (
      <Card title="Authority Map" subtitle="What the merchant delegates to agents — and what it never does">
        <p className="text-xs text-ink-faint">
          The merchant policy has not loaded, so what is delegated is unknown. Nothing here is a denial — check the
          API on :3001 and reload.
        </p>
      </Card>
    );
  }
  return (
    <Card title="Authority Map" subtitle="What the merchant delegates to agents — and what it never does">
      <div className="grid gap-3 md:grid-cols-2">
        <Branch
          label="MERCHANT · SELL"
          items={[
            { text: 'CART (create / modify)', allowed: policy?.allowCartModification ?? false },
            { text: 'UPSELL', allowed: policy?.allowUpsells ?? false },
            {
              text: `PAYMENT ≤ ${policy !== null ? formatINR(policy.maxOrderAmountPaise) : '—'}`,
              allowed: true,
            },
          ]}
        />
        <Branch
          label="MERCHANT · MODIFY (privileged)"
          items={[
            { text: 'REFUND', allowed: false },
            { text: 'PAYOUT', allowed: false },
            { text: 'POLICY', allowed: false },
            { text: 'MANDATE', allowed: false },
          ]}
        />
      </div>
      <div className="mt-3 space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-ink-faint">Agent capabilities</p>
        {agents.map((agent) => (
          <div key={agent.id} className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono text-ink-soft">{agent.id}</span>
            {agent.capabilities.map((cap) => (
              <Badge key={cap} tone="neutral" mono>
                {cap}
              </Badge>
            ))}
          </div>
        ))}
        <p className="text-[10px] text-ink-faint">
          Agents never receive direct payment-provider access; unknown capabilities fail closed.
        </p>
      </div>
    </Card>
  );
}