import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyEvent } from '../core/reducer.js';
import type { Run, RunnerEvent } from '../core/types.js';
import { Store } from './database.js';

class ProtocolError extends Error {}
export interface Cursor { offset: number; lastSeq: number; finished: boolean; finishedOffset: number | null }
export function cursor(store: Store, runId: string, segment: number): Cursor {
  const r = store.db.prepare('SELECT * FROM cursors WHERE run_id=? AND segment=?').get(runId, segment);
  return { offset: Number(r?.byte_offset ?? 0), lastSeq: Number(r?.last_seq ?? 0), finished: !!r?.finished, finishedOffset: r?.finished_offset == null ? null : Number(r.finished_offset) };
}
export function stateEvent(store: Store, run: Run, from: string | null, now: number): void {
  store.emit('run.state_changed', { from, to: run.state, reason: run.reason, occupies_slot: run.reservation, version: run.version }, run, now);
}
// NDJSON is durably appended by the shim first. All derived facts + cursor then commit together.
export function ingest(store: Store, runId: string, path: string, now = Date.now(), reduce = applyEvent): number {
  const initial = store.get(runId);
  const bytes = readFileSync(path);
  return store.transaction(() => {
    const run = store.get(runId);
    const c = cursor(store, runId, initial.segment);
    if (bytes.length < c.offset) {
      store.diagnostic(runId, 'file_shorter_than_offset', { length: bytes.length, offset: c.offset });
      return 0; // Never rewind the committed facts after host power loss.
    }
    let offset = c.offset, count = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      if (end < 0) break;
      const line = bytes.subarray(offset, end);
      offset = end + 1;
      const before = run.state;
      try {
        if (line.length > 1_048_576) throw new ProtocolError('line_too_large');
        const frame = JSON.parse(line.toString('utf8')) as { jsonrpc?: string; method?: string; params?: RunnerEvent; id?: unknown; error?: unknown; result?: { accepted?: boolean } };
        if (!frame || typeof frame !== 'object' || frame.jsonrpc !== '2.0') throw new ProtocolError('invalid_jsonrpc');
        if (frame.method === 'event') {
          const e = frame.params;
          if (!e || !Number.isSafeInteger(e.seq) || e.seq < 1 || typeof e.type !== 'string' || typeof e.ts !== 'string' || !e.data || typeof e.data !== 'object' || Array.isArray(e.data)) throw new ProtocolError('invalid_event');
          const digest = createHash('sha256').update(line).digest('hex');
          const duplicate = store.db.prepare('SELECT digest,end_offset FROM consumed WHERE run_id=? AND segment=? AND seq=?').get(run.id, run.segment, e.seq);
          if (duplicate) { if (duplicate.digest !== digest) throw new ProtocolError('sequence_conflict'); if (Number(duplicate.end_offset) !== offset) throw new ProtocolError('duplicate_sequence'); continue; }
          if (c.finished) throw new ProtocolError('output_after_finished');
          if (e.seq !== c.lastSeq + 1 || (c.lastSeq === 0 && e.type !== 'session.started')) throw new ProtocolError('sequence_gap_or_invalid_first_event');
          // Reducer exceptions are protocol violations; injected/storage exceptions propagate and roll back.
          if (reduce === applyEvent) {
            try { reduce(run, e, now); } catch (error) { run.protocolViolation = String(error); }
          } else reduce(run, e, now);
          store.db.prepare('INSERT INTO consumed VALUES (?,?,?,?,?)').run(run.id, run.segment, e.seq, digest, offset);
          c.lastSeq = e.seq; c.finished = e.type === 'run.finished'; if (c.finished) c.finishedOffset = offset;
          const runSeq = store.activity(run, run.segment, e.type, e.data, e.ts);
          store.emit('run.activity', { segment: run.segment, run_seq: runSeq, event: e }, run, now);
          if (e.type === 'usage' || e.type === 'run.finished') {
            run.version++; store.emit('run.usage', { usage: run.usage, version: run.version }, run, now);
          }
          count++;
        } else {
          if (!('id' in frame) || frame.error || (c.finishedOffset !== null && offset > c.finishedOffset)) throw new ProtocolError('unexpected_rpc_frame');
          if (typeof frame.id === 'string' && frame.result?.accepted) {
            const command = store.db.prepare('SELECT params,method FROM commands WHERE run_id=? AND segment=? AND command_id=?').get(run.id,run.segment,frame.id);
            if (command) {
              store.db.prepare('UPDATE commands SET delivered=1 WHERE run_id=? AND segment=? AND command_id=?').run(run.id,run.segment,frame.id);
              if (command.method === 'run.input') {
                const p = JSON.parse(command.params as string) as { input_id: string };
                const message = run.messages.find(m => m.id === p.input_id);
                if (message && message.state !== 'invalidated' && message.state !== 'delivered') {
                  message.state = 'delivered'; run.version++;
                  store.emit('run.updated', { version: run.version, changes: { delivered_input: message.id } }, run, now);
                }
              }
            }
          }
        }
      } catch (error) {
        // Test reducers and database failures must abort, never become protocol errors.
        if (reduce !== applyEvent || (!(error instanceof ProtocolError) && !(error instanceof SyntaxError))) throw error;
        run.protocolViolation = String(error);
        store.diagnostic(run.id, 'protocol_violation', { offset: offset - line.length - 1, error: String(error) });
      }
      if (run.state !== before) stateEvent(store, run, before, now);
    }
    store.put(run);
    store.db.prepare('INSERT INTO cursors VALUES (?,?,?,?,?,?) ON CONFLICT(run_id,segment) DO UPDATE SET byte_offset=excluded.byte_offset,last_seq=excluded.last_seq,finished=excluded.finished,finished_offset=excluded.finished_offset')
      .run(run.id, run.segment, offset, c.lastSeq, Number(c.finished), c.finishedOffset);
    return count;
  });
}
