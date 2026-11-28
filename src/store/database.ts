import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Run } from '../core/types.js';

export interface GlobalEvent { seq: number; type: string; ts: string; project_id: string | null; task_id: string | null; run_id: string | null; data: Record<string, unknown> }
export interface EventTarget { projectId: string | null; taskId?: string | null; id?: string | null }
export class Store {
  readonly db: DatabaseSync;
  private inTransaction = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_versions (version TEXT PRIMARY KEY, digest TEXT NOT NULL)');
    const directory = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));
    for (const file of readdirSync(directory).filter(f => /^\d+.*\.sql$/.test(f)).sort()) {
      const sql = readFileSync(`${directory}/${file}`, 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      const old = this.db.prepare('SELECT digest FROM schema_versions WHERE version=?').get(file);
      if (old) { if (old.digest !== digest) throw new Error(`migration_changed: ${file}`); continue; }
      this.transaction(() => { this.db.exec(sql); this.db.prepare('INSERT INTO schema_versions VALUES (?,?)').run(file, digest); });
    }
  }
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) throw new Error('nested_transaction');
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.inTransaction = false; }
  }
  private assertTransaction(): void { if (!this.inTransaction) throw new Error('transaction_required'); }
  put(run: Run): void {
    this.assertTransaction();
    this.db.prepare('INSERT INTO runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(run.id, JSON.stringify(run));
  }
  get(id: string): Run {
    const row = this.db.prepare('SELECT payload FROM runs WHERE id=?').get(id);
    if (!row) throw new Error(`run_not_found: ${id}`);
    return JSON.parse(row.payload as string) as Run;
  }
  list(): Run[] { return this.db.prepare('SELECT payload FROM runs ORDER BY rowid').all().map(r => JSON.parse(r.payload as string) as Run); }
  meta(): { high: number; complete: number; epoch: number; boot: string | null } {
    const r = this.db.prepare('SELECT * FROM instance_meta WHERE id=1').get()!;
    return { high: Number(r.high_seq), complete: Number(r.complete_from_seq), epoch: Number(r.daemon_epoch), boot: r.boot_id as string | null };
  }
  beginEpoch(bootId: string): { epoch: number; hostRestart: boolean } {
    return this.transaction(() => {
      const old = this.meta();
      this.db.prepare('UPDATE instance_meta SET daemon_epoch=daemon_epoch+1, boot_id=? WHERE id=1').run(bootId);
      return { epoch: old.epoch + 1, hostRestart: old.boot !== null && old.boot !== bootId };
    });
  }
  emit(type: string, data: Record<string, unknown>, target: Run | EventTarget | null = null, now = Date.now()): GlobalEvent {
    this.assertTransaction();
    if (this.meta().high >= Number.MAX_SAFE_INTEGER) throw new Error('sequence_exhausted');
    const row = this.db.prepare('UPDATE instance_meta SET high_seq=high_seq+1 WHERE id=1 RETURNING high_seq').get()!;
    const projectId = target?.projectId ?? null;
    const taskId = target && 'taskId' in target ? (target.taskId ?? null) : null;
    const runId = target && 'id' in target ? (target.id ?? null) : null;
    const event: GlobalEvent = { seq: Number(row.high_seq), type, ts: new Date(now).toISOString(), project_id: projectId, task_id: taskId, run_id: runId, data };
    this.db.prepare('INSERT INTO events VALUES (?,?,?)').run(event.seq, now, JSON.stringify(event)); return event;
  }
  activity(run: Run, segment: number, type: string, data: Record<string, unknown>, ts = new Date().toISOString()): number {
    this.assertTransaction();
    // Run activity is never pruned, so MAX here is safe; the global stream uses its own durable counter.
    const row = this.db.prepare('SELECT COALESCE(MAX(run_seq),0)+1 AS next FROM activity WHERE run_id=?').get(run.id)!;
    const seq = Number(row.next);
    this.db.prepare('INSERT INTO activity VALUES (?,?,?,?)').run(run.id, seq, segment, JSON.stringify({ run_seq: seq, segment, ts, type, data })); return seq;
  }
  diagnostic(runId: string | null, kind: string, data: Record<string, unknown>): void {
    this.assertTransaction(); this.db.prepare('INSERT INTO diagnostics(run_id,kind,payload) VALUES (?,?,?)').run(runId, kind, JSON.stringify(data));
  }
  eventsSince(since: number, limit = 100): { reset: boolean; complete_from_seq: number; events: GlobalEvent[]; event_seq: number } {
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_event_cursor');
    return this.transaction(() => {
      const { high, complete } = this.meta();
      const reset = since + 1 < complete;
      const rows = reset ? [] : this.db.prepare('SELECT payload FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(since, limit);
      return { reset, complete_from_seq: complete, event_seq: high, events: rows.map(r => JSON.parse(r.payload as string) as GlobalEvent) };
    });
  }
  prune(before: number, now: number, retentionMs = 14 * 86_400_000): void {
    if (retentionMs < 14 * 86_400_000) throw new Error('retention_too_short');
    this.transaction(() => {
      const { high, complete } = this.meta();
      if (!Number.isSafeInteger(before) || before < complete || before > high + 1) throw new Error('invalid_prune_point');
      if (this.db.prepare('SELECT seq FROM events WHERE seq<? AND ts>? LIMIT 1').get(before, now - retentionMs)) throw new Error('retention_not_elapsed');
      this.db.prepare('DELETE FROM events WHERE seq<?').run(before);
      this.db.prepare('UPDATE instance_meta SET complete_from_seq=? WHERE id=1').run(before);
    });
  }
  snapshot(): { runs: Run[]; event_seq: number } {
    return this.transaction(() => ({ runs: this.list(), event_seq: this.meta().high }));
  }
  close(): void { this.db.close(); }
}
