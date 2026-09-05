// apps/api/src/db/client.ts  (MODIFIED — full reprint)
import fs from 'node:fs';
import path from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: AppDatabase;
  sqlite: SqliteDatabase;
  close(): void;
}

/**
 * Resolves DATABASE_URL. ':memory:' is used by tests and the fuzz sandbox.
 * Relative paths resolve against the process working directory (all npm
 * scripts execute from the repository root).
 */
export function resolveDatabasePath(url: string): string {
  if (url === ':memory:') return ':memory:';
  let candidate = url;
  if (candidate.startsWith('file:')) {
    candidate = candidate.slice('file:'.length);
  }
  if (path.isAbsolute(candidate)) return candidate;
  return path.resolve(process.cwd(), candidate);
}

/** Creates (or opens) the SQLite database with pragmatic production settings. */
export function createDatabase(url: string): DatabaseHandle {
  const target = resolveDatabasePath(url);
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const sqlite = new DatabaseConstructor(target);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    close(): void {
      sqlite.close();
    },
  };
}

/**
 * Full clone of a database into fresh memory (schema + data). Used by the
 * counterfactual service so "what would happen if…?" runs the REAL
 * AuthorizationEngine against a snapshot of live state and then discards it —
 * zero real financial state is mutated (§46).
 */
export async function cloneDatabase(source: SqliteDatabase): Promise<SqliteDatabase> {
  const dest = new DatabaseConstructor(':memory:');
  const ddlRows = source.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger')").all() as Array<{ sql: string }>;
  for (const row of ddlRows) {
    try {
      dest.exec(row.sql);
    } catch {
      // Ignored if already created
    }
  }
  const tableRows = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  for (const { name } of tableRows) {
    const rows = source.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      const cols = Object.keys(rows[0]!);
      const placeholders = cols.map(() => '?').join(', ');
      const stmt = dest.prepare(`INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`);
      const insertMany = dest.transaction((items: Array<Record<string, unknown>>) => {
        for (const item of items) {
          stmt.run(cols.map((col) => item[col]));
        }
      });
      insertMany(rows);
    }
  }
  return dest;
}

/** Wraps an existing raw sqlite connection in the standard DatabaseHandle. */
export function handleFromSqlite(sqlite: SqliteDatabase): DatabaseHandle {
  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    close(): void {
      sqlite.close();
    },
  };
}