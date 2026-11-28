import type { DatabaseSync } from 'node:sqlite';

export function ensureApiSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      principal TEXT NOT NULL,
      client_ref TEXT,
      request_fingerprint TEXT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tasks_client_ref
      ON api_tasks(principal, project_id, client_ref)
      WHERE client_ref IS NOT NULL;

    CREATE TABLE IF NOT EXISTS api_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      client_ref TEXT,
      spec_fingerprint TEXT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_runs_client_ref
      ON api_runs(task_id, client_ref)
      WHERE client_ref IS NOT NULL;

    CREATE TABLE IF NOT EXISTS api_idempotency (
      principal TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      request_id TEXT NOT NULL,
      status TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      permanent INTEGER NOT NULL,
      status_code INTEGER,
      response_body TEXT,
      project_id TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY (principal, method, path, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS api_rulings (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_worktree_releases (
      run_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_journal (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const idemCols = db.prepare(`PRAGMA table_info(api_idempotency)`).all() as { name: string }[];
  if (!idemCols.some(c => c.name === 'project_id')) {
    db.exec(`ALTER TABLE api_idempotency ADD COLUMN project_id TEXT`);
  }
}
