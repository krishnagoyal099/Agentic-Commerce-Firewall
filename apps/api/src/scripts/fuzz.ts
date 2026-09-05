// apps/api/src/scripts/fuzz.ts
/**
 * CLI fuzzer: `npm run fuzz [cases] [seed] [maxSequenceLength]`
 * Persists the run (real stats + bypasses) to the configured database.
 */
import { loadConfig } from '../config';
import { buildAppContext } from '../appContext';
import { buildServiceContext } from '../context';
import { createDatabase } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedDatabase } from '../db/seed';
import { SystemClock } from '../utils/clock';

async function main(): Promise<void> {
  const cases = Number.parseInt(process.argv[2] ?? '5000', 10);
  const seed = Number.parseInt(process.argv[3] ?? '1337', 10);
  const maxSequenceLength = Number.parseInt(process.argv[4] ?? '6', 10);
  if (!Number.isInteger(cases) || cases < 1 || cases > 50_000) {
    console.error('cases must be an integer between 1 and 50000');
    process.exit(1);
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) {
    console.error('seed must be an integer between 0 and 2147483647');
    process.exit(1);
  }
  if (!Number.isInteger(maxSequenceLength) || maxSequenceLength < 1 || maxSequenceLength > 12) {
    console.error('maxSequenceLength must be an integer between 1 and 12');
    process.exit(1);
  }

  const config = loadConfig();
  const handle = createDatabase(config.databaseUrl);
  runMigrations(handle.sqlite);
  const clock = new SystemClock();
  seedDatabase(handle.db, clock);
  const ctx = buildAppContext(buildServiceContext(handle, clock, config), handle);
  try {
    const out = await ctx.fuzzer.run({ cases, seed, maxSequenceLength });
    const s = out.run.stats;
    console.log('FIREWALL SECURITY TEST');
    console.log(`Cases tested:       ${s.totalCases.toLocaleString('en-IN')}`);
    console.log(`Blocked:            ${s.blocked}`);
    console.log(`Reauthorized:       ${s.reauthorized}`);
    console.log(`Human approval:     ${s.humanApproval}`);
    console.log(`Allowed:            ${s.allowed}`);
    console.log(`Policy violations:  ${s.policyViolations}`);
    console.log(`Bypasses:           ${s.bypasses}`);
    console.log(`Failures:           ${s.failures}`);
    console.log(`Duration:           ${out.run.durationMs.toLocaleString('en-IN')} ms (seed ${seed})`);
    if (out.bypasses.length > 0) {
      console.log('\nBYPASSES DETECTED:');
      for (const b of out.bypasses.slice(0, 10)) {
        console.log(`  case ${b.caseIndex}: ${b.description} → ${b.outcome} (${b.reason})`);
      }
      process.exitCode = 1;
    }
  } finally {
    handle.close();
  }
}

main().catch((err: unknown) => {
  console.error('[fuzz] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});