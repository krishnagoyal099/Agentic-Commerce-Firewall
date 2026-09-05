// apps/web/src/pages/ProtocolPage.tsx
import { errMessage } from '../api/client';
import { ProtocolBypassPanel } from '../components/protocol/ProtocolBypassPanel';
import { ProtocolDemoView } from '../components/protocol/ProtocolDemoView';
import { ProtocolFlow } from '../components/protocol/ProtocolFlow';
import { ProtocolLog } from '../components/protocol/ProtocolLog';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { useProtocolDemo } from '../hooks';

export function ProtocolPage() {
  const demo = useProtocolDemo();
  return (
    <div className="space-y-6">
      <ProtocolFlow />
      <Card title="End-to-End Protocol Demo" subtitle="Discover → search → inspect → cart → propose → evaluate → pay → capture → order → receipt">
        <Button variant="primary" loading={demo.isPending} onClick={() => demo.mutate()}>
          RUN PROTOCOL DEMO
        </Button>
        {demo.error !== null ? <p className="mt-3 text-xs text-block">{errMessage(demo.error)}</p> : null}
      </Card>
      {demo.data !== undefined ? <ProtocolDemoView report={demo.data} /> : null}
      <ProtocolBypassPanel />
      <ProtocolLog />
    </div>
  );
}