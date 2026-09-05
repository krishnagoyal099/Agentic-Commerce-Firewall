// apps/web/src/pages/AttackLabPage.tsx
import { AdversarialPanel } from '../components/attacks/AdversarialPanel';
import { AttackLab } from '../components/attacks/AttackLab';
import { FuzzPanel } from '../components/attacks/FuzzPanel';

export function AttackLabPage() {
  return (
    <div className="space-y-6">
      <AttackLab />
      <FuzzPanel />
      <AdversarialPanel />
    </div>
  );
}