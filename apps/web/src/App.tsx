// apps/web/src/App.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { AttackLabPage } from './pages/AttackLabPage';
import { AuditPage } from './pages/AuditPage';
import { FirewallPage } from './pages/FirewallPage';
import { GrowthPage } from './pages/GrowthPage';
import { MerchantPage } from './pages/MerchantPage';
import { OverviewPage } from './pages/OverviewPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { ProtocolPage } from './pages/ProtocolPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<OverviewPage />} />
            <Route path="/firewall" element={<FirewallPage />} />
            <Route path="/protocol" element={<ProtocolPage />} />
            <Route path="/growth" element={<GrowthPage />} />
            <Route path="/attacks" element={<AttackLabPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/merchant" element={<MerchantPage />} />
            <Route path="/audit" element={<AuditPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}