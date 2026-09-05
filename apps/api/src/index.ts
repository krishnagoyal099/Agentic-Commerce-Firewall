// apps/api/src/index.ts  (MODIFIED — full reprint; awaits the now-async bootstrap)
/** API entrypoint: env → migrate → seed → bootstrap demo state → services → HTTP. */
import { buildApp } from './app';
import { buildAppContext } from './appContext';
import { loadConfig } from './config';
import { buildServiceContext } from './context';
import { createDatabase } from './db/client';
import { runMigrations } from './db/migrate';
import { seedDatabase } from './db/seed';
import { SystemClock } from './utils/clock';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.paymentProviderWarning !== null) {
    console.warn(`[api] ${config.paymentProviderWarning}`);
  }
  const handle = createDatabase(config.databaseUrl);
  runMigrations(handle.sqlite);
  const clock = new SystemClock();
  seedDatabase(handle.db, clock);
  const ctx = buildAppContext(buildServiceContext(handle, clock, config), handle);
  const boot = await ctx.demo.ensureBootstrapped();
  if (boot.bootstrapped && boot.reset !== null) {
    console.log(
      `[api] Demo bootstrapped: ${boot.reset.historyOrders} history orders (real flows), mandate ${boot.reset.mandateId}.`,
    );
  }
  const app = await buildApp(ctx);
  await app.listen({ port: config.apiPort, host: '0.0.0.0' });
  console.log(
    `[api] Agentic Commerce Firewall listening on :${config.apiPort} (provider: ${ctx.provider.name}, db: ${config.databaseUrl})`,
  );

  const shutdown = (signal: string): void => {
    console.log(`[api] ${signal} received; shutting down.`);
    void app.close().then(() => {
      handle.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[api] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});