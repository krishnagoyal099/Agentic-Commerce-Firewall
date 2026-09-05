// apps/api/src/routes/metrics.ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../appContext';

export function registerMetricsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/metrics', async () => ctx.metricsService.snapshot());
}