// apps/api/src/vercel.ts
// Vercel serverless handler for the Agentic Commerce Firewall API.
//
// Vercel invokes each serverless function as a standard Node.js (req, res)
// pair. Fastify's underlying http.Server can receive these directly via
// app.server.emit('request', req, res) after the app is ready.
//
// The booted FastifyInstance is cached in the module scope so warm Lambda
// containers do not re-run migrations/seed on every request — only on a
// cold start.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './app.js';
import { buildAppContext } from './appContext.js';
import { loadConfig } from './config.js';
import { buildServiceContext } from './context.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { SystemClock } from './utils/clock.js';
import type { FastifyInstance } from 'fastify';

/** Singleton — reused across warm invocations within the same Lambda container. */
let appPromise: Promise<FastifyInstance> | null = null;

function getApp(): Promise<FastifyInstance> {
  if (appPromise !== null) return appPromise;

  appPromise = (async (): Promise<FastifyInstance> => {
    const config = loadConfig();
    const handle = createDatabase(config.databaseUrl);
    runMigrations(handle.sqlite);
    const clock = new SystemClock();
    seedDatabase(handle.db, clock);
    const ctx = buildAppContext(buildServiceContext(handle, clock, config), handle);
    await ctx.demo.ensureBootstrapped();
    const app = await buildApp(ctx);
    await app.ready();
    return app;
  })();

  // Clear on failure so the next cold start retries.
  appPromise.catch(() => {
    appPromise = null;
  });

  return appPromise;
}

/**
 * Standard Node.js (req, res) handler consumed by Vercel's serverless runtime.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp();
  app.server.emit('request', req, res);
}
