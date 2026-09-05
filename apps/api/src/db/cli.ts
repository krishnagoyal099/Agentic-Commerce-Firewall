// apps/api/src/db/cli.ts
/**
 * CLI entry: `tsx apps/api/src/db/cli.ts <migrate|seed|reset>`
 * Exposed as npm scripts `db:migrate` and `db:seed`.
 */
import { loadConfig } from '../config';
import { SystemClock } from '../utils/clock';
import { createDatabase } from './client';
import { runMigrations } from './migrate';
import { resetDatabase, seedDatabase } from './seed';

interface MigrationSummary {
  name: string;
  hash: string;
  appliedAt: string;
}

function usage(): void {
  console.log('Usage: tsx apps/api/src/db/cli.ts <migrate|seed|reset>');
}

function main(): void {
  const command = process.argv[2];
  if (!command) {
    usage();
    process.exit(1);
  }
  const config = loadConfig();
  if (config.paymentProviderWarning) {
    console.warn(`[warn] ${config.paymentProviderWarning}`);
  }
  const handle = createDatabase(config.databaseUrl);
  try {
    switch (command) {
      case 'migrate': {
        const applied = runMigrations(handle.sqlite);
        console.log(JSON.stringify({ ok: true, migrations: applied }, null, 2));
        break;
      }
      case 'seed': {
        runMigrations(handle.sqlite);
        const result = seedDatabase(handle.db, new SystemClock());
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        break;
      }
      case 'reset': {
        runMigrations(handle.sqlite);
        resetDatabase(handle.db);
        const result = seedDatabase(handle.db, new SystemClock());
        console.log(JSON.stringify({ ok: true, reset: true, ...result }, null, 2));
        break;
      }
      default: {
        usage();
        handle.close();
        process.exit(1);
      }
    }
  } finally {
    handle.close();
  }
}

main();