// apps/api/src/routes/index.ts  (MODIFIED — full reprint)
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../appContext';
import { registerAttackRoutes } from './attacks';
import { registerAdversarialRoutes } from './adversarial';
import { registerAgentRoutes } from './agents';
import { registerAuditRoutes } from './audit';
import { registerCartRoutes } from './carts';
import { registerCounterfactualRoutes } from './counterfactual';
import { registerDecisionRoutes } from './decisions';
import { registerDemoRoutes } from './demo';
import { registerFuzzerRoutes } from './fuzzer';
import { registerGrowthRoutes } from './growth';
import { registerHealthRoutes } from './health';
import { registerIntentRoutes } from './intent';
import { registerMandateRoutes } from './mandates';
import { registerMetricsRoutes } from './metrics';
import { registerOrderRoutes } from './orders';
import { registerPaymentRoutes } from './payments';
import { registerPolicyRoutes } from './policy';
import { registerProductRoutes } from './products';
import { registerProposalRoutes } from './proposals';
import { registerProtocolRoutes } from './protocol';

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerHealthRoutes(app, ctx);
  registerProductRoutes(app, ctx);
  registerIntentRoutes(app, ctx);
  registerMandateRoutes(app, ctx);
  registerCartRoutes(app, ctx);
  registerProposalRoutes(app, ctx);
  registerOrderRoutes(app, ctx);
  registerPaymentRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerMetricsRoutes(app, ctx);
  registerPolicyRoutes(app, ctx);
  registerDecisionRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerProtocolRoutes(app, ctx);
  registerGrowthRoutes(app, ctx);
  registerAdversarialRoutes(app, ctx);
  registerDemoRoutes(app, ctx);
  registerAttackRoutes(app, ctx);
  registerCounterfactualRoutes(app, ctx);
  registerFuzzerRoutes(app, ctx);
}