// apps/api/src/appContext.ts  (MODIFIED — full reprint)
import type { DatabaseHandle } from './db/client';
import type { ServiceContext } from './context';
import { ProtocolGateway } from './protocol/ProtocolGateway';
import { ProtocolDemoService } from './protocol/ProtocolDemoService';
import { MCPCommerceAdapter } from './protocol/mcp/MCPCommerceAdapter';
import { AttackService } from './attacks';
import { AdversarialAgent } from './services/AdversarialAgent';
import { BuyerAgent } from './services/BuyerAgent';
import { CounterfactualService } from './services/CounterfactualService';
import { DemoService } from './services/DemoService';
import { FuzzerService } from './services/FuzzerService';
import { GrowthAgent } from './services/GrowthAgent';
import { IntentService } from './services/IntentService';
import { MetricsService } from './services/MetricsService';

export interface AppContext extends ServiceContext {
  handle: DatabaseHandle;
  gateway: ProtocolGateway;
  adapter: MCPCommerceAdapter;
  metricsService: MetricsService;
  protocolDemo: ProtocolDemoService;
  buyer: BuyerAgent;
  growth: GrowthAgent;
  adversarial: AdversarialAgent;
  attackService: AttackService;
  counterfactual: CounterfactualService;
  fuzzer: FuzzerService;
  intentService: IntentService;
  demo: DemoService;
}

export function buildAppContext(ctx: ServiceContext, handle: DatabaseHandle): AppContext {
  const gateway = new ProtocolGateway(ctx);
  const adapter = new MCPCommerceAdapter(ctx, gateway);
  const metricsService = new MetricsService(ctx);
  const buyer = new BuyerAgent(ctx, gateway);
  const growth = new GrowthAgent(ctx, gateway);
  const adversarial = new AdversarialAgent(ctx, gateway);
  const attackService = new AttackService(ctx, gateway, adapter);
  const counterfactual = new CounterfactualService(ctx);
  const fuzzer = new FuzzerService(ctx);
  const intentService = new IntentService(ctx);
  return {
    ...ctx,
    handle,
    gateway,
    adapter,
    metricsService,
    protocolDemo: new ProtocolDemoService(ctx, adapter),
    buyer,
    growth,
    adversarial,
    attackService,
    counterfactual,
    fuzzer,
    intentService,
    demo: new DemoService(ctx, handle, gateway, buyer, growth, metricsService, intentService),
  };
}