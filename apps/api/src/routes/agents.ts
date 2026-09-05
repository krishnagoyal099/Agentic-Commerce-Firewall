// apps/api/src/routes/agents.ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../appContext';

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/agents', async () => ({
    agents: ctx.capabilities.listAgents().map((row) => ({
      id: row.id,
      name: row.name,
      agentType: row.agentType,
      capabilities: row.capabilities,
      active: row.active,
    })),
  }));
}
