// apps/api/src/db/migrate.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { sha256Hex } from '../utils/hash';

export interface MigrationRecord {
  name: string;
  hash: string;
  appliedAt: string;
}

interface MigrationRow {
  name: string;
  hash: string;
  applied_at: string;
}

const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

function migrationsDir(): string {
  // .../apps/api/src/db -> .../apps/api/drizzle
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'drizzle');
}

/**
 * Applies pending migrations in lexical order, each inside a transaction,
 * recording a SHA-256 of the file content. An already-applied migration whose
 * content hash changed is a hard error — history is never silently rewritten.
 * Safe to call repeatedly (idempotent).
 */
export function runMigrations(sqlite: SqliteDatabase): MigrationRecord[] {
  sqlite.exec(MIGRATIONS_TABLE_SQL);
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new Error(`No .sql migration files found in ${dir}`);
  }

  const select = sqlite.prepare<unknown[], MigrationRow>(
    'SELECT name, hash, applied_at FROM _migrations WHERE name = ?',
  );
  const insert = sqlite.prepare(
    'INSERT INTO _migrations (name, hash, applied_at) VALUES (?, ?, ?)',
  );

  const applied: MigrationRecord[] = [];
  for (const name of files) {
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    const hash = sha256Hex(sql);
    const existing = select.get(name) as MigrationRow | undefined;
    if (existing) {
      if (existing.hash !== hash) {
        throw new Error(
          `Migration ${name} was modified after being applied; refusing to run tampered migrations.`,
        );
      }
      applied.push({ name, hash, appliedAt: existing.applied_at });
      continue;
    }
    const transaction = sqlite.transaction(() => {
      sqlite.exec(sql);
      insert.run(name, hash, new Date().toISOString());
    });
    transaction();
    const record = select.get(name) as MigrationRow;
    applied.push({ name: record.name, hash: record.hash, appliedAt: record.applied_at });
  }
  return applied;
}