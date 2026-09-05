// apps/api/src/routes/health.ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../appContext';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => {
    const policy = ctx.policies.getActivePolicy(ctx.merchantId);
    return {
      status: 'ok',
      service: 'agentic-commerce-firewall',
      version: '1.0.0',
      environment: ctx.config.nodeEnv,
      database: 'sqlite',
      paymentProvider: ctx.provider.name,
      merchant: { id: ctx.merchantId, policyVersion: policy?.version ?? null },
      auditChainValid: ctx.audit.verifyChain().valid,
      protocolAdapters: [ctx.adapter.name],
      timestamp: ctx.clock.now().toISOString(),
    };
  });
}