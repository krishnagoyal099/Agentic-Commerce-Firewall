// apps/api/src/routes/protocol.ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../appContext';

export function registerProtocolRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/protocol/status', async () => {
    const tools = ctx.adapter.listTools();
    return {
      adapters: [
        {
          name: ctx.adapter.name,
          protocol: ctx.adapter.protocolName,
          toolCount: tools.length,
          tools: tools.map((t) => t.name),
        },
      ],
      recentRequests: ctx.gateway.listProtocolRequests(30),
      totals: ctx.gateway.protocolTotals(),
      mcpServer: {
        transport: 'stdio',
        startCommand: 'npm run mcp',
        note: 'The stdio MCP server exposes the same tools through the same adapter, gateway, and AuthorizationEngine as REST.',
      },
    };
  });

  app.post('/api/protocol/demo', async () => ctx.protocolDemo.run());

  app.get('/api/protocol/requests', async () => ({
    requests: ctx.gateway.listProtocolRequests(100),
  }));
}