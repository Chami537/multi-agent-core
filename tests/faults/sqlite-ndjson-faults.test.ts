import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Runtime } from '../../dist/core/runtime.js';
import { emptyUsage } from '../../dist/core/types.js';
import { repairTail, type Producer } from '../../dist/host/logs.js';
import { alive, identity, jsonFile, signalProcess } from '../../dist/host/process.js';
import { Store } from '../../dist/store/database.js';
import { cursor, ingest } from '../../dist/store/ingest.js';
import { allocations, cleanup, makeRuntime, markerPreserver, state, until, workspace } from '../helpers/runtime.js';

const workerPath = resolve('tests/faults/fault-worker.mjs');
const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function killAndWait(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(res => {
    if (child.exitCode !== null || child.signalCode !== null) {
      res({ code: child.exitCode, signal: child.signalCode });
    } else {
      child.once('exit', (code, signal) => res({ code, signal }));
    }
  });
  const id = identity(child.pid!);
  signalProcess(id, 'SIGKILL');
  await until(() => !alive(id), 5_000);
  return exitPromise;
}

afterEach(async () => {
  await cleanup();
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

describe('SQLite & NDJSON SIGKILL fault injection', () => {
  it('SIGKILL during WAL write preserves committed transactions and leaves no uncommitted state', async () => {
    const root = makeTempRoot('mac-fault-wal-');
    const ws = join(root, 'workspace');
    mkdirSync(ws, { recursive: true });
    const dbPath = join(root, 'state.sqlite');
    const readyPath = join(root, 'ready.json');

    const child = spawn(process.execPath, [workerPath, 'wal_write_mid_tx', dbPath, readyPath, ws], { stdio: 'ignore' });
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      await until(() => existsSync(readyPath), 5_000);
      exit = await killAndWait(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    expect(exit.signal).toBe('SIGKILL');
    expect(exit.code).toBeNull();

    const store = new Store(dbPath);
    try {
      const runs = store.list();
      expect(runs.map(r => r.id)).toEqual(['committed_0', 'committed_1', 'committed_2', 'committed_3', 'committed_4']);
      expect(() => store.get('uncommitted_run')).toThrow('run_not_found');

      const meta = store.meta();
      expect(meta.high).toBe(5);
      const events = store.eventsSince(0, 100).events;
      expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(events.every(e => !('uncommitted' in e.data))).toBe(true);

      const nextEvent = store.transaction(() => store.emit('alert', { recovered: true }));
      expect(nextEvent.seq).toBe(6);
    } finally {
      store.close();
    }
  });

  it('SIGKILL during NDJSON append truncates partial tail on repairTail and ingests complete lines cleanly', async () => {
    const rt = makeRuntime();
    const r = rt.create({ workspace: workspace(rt) });
    r.segment = 1;
    r.state = 'running';
    r.reservation = true;
    rt.store.transaction(() => rt.store.put(r));

    const segDir = join(r.runDir, 'segments', '1');
    mkdirSync(segDir, { recursive: true });
    const ndjsonPath = join(segDir, 'protocol.ndjson');
    writeFileSync(ndjsonPath, '');
    const readyPath = join(rt.root, 'ndjson-ready.json');

    const child = spawn(process.execPath, [workerPath, 'ndjson_append_mid_line', segDir, readyPath], { stdio: 'ignore' });
    let info: { shim: Producer['shim']; pgid: number | null; boot: string; completeBytes: number };
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      await until(() => existsSync(readyPath), 5_000);
      info = jsonFile<typeof info>(readyPath)!;
      exit = await killAndWait(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    expect(exit.signal).toBe('SIGKILL');
    expect(exit.code).toBeNull();

    const repaired = repairTail(segDir, { shim: info.shim, pgid: info.pgid, boot: info.boot });
    expect(repaired).not.toBeNull();
    expect(repaired!.removed).toBeGreaterThan(0);
    expect(repaired!.digest).toHaveLength(64);
    expect(readFileSync(ndjsonPath).length).toBe(info.completeBytes);

    const count = ingest(rt.store, r.id, ndjsonPath);
    expect(count).toBe(3);
    expect(cursor(rt.store, r.id, 1)).toMatchObject({ offset: info.completeBytes, lastSeq: 3, finished: false });
    expect(rt.store.get(r.id).protocolViolation).toBeNull();
    expect(rt.store.get(r.id).usage.input_tokens).toBe(10);

    // Subsequent complete line continues cleanly from seq 4
    appendFileSync(
      ndjsonPath,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          seq: 4,
          ts: new Date(0).toISOString(),
          type: 'run.finished',
          data: {
            outcome: 'completed',
            error: null,
            work_started: true,
            usage: { ...emptyUsage(), input_tokens: 10, steps: 1, completeness: 'exact' },
            final_message: 'ok',
            model: {},
            reasoning_effort: {},
            steps: 1,
            turns: 0,
            resume_token: null,
            native_session_id: null,
            native_exit: { code: 0, signal: null },
          },
        },
      }) + '\n',
    );
    expect(ingest(rt.store, r.id, ndjsonPath)).toBe(1);
    expect(cursor(rt.store, r.id, 1).lastSeq).toBe(4);
    expect(rt.store.get(r.id).candidate?.data.outcome).toBe('completed');
  });

  it('SIGKILL while advancing event seq rolls back uncommitted seq, keeps cursor/consumed/usage/events consistent, and diagnoses gaps', async () => {
    const rt = makeRuntime();
    const r = rt.create({ workspace: workspace(rt) });
    r.segment = 1;
    r.state = 'running';
    r.reservation = true;
    rt.store.transaction(() => rt.store.put(r));

    const segDir = join(r.runDir, 'segments', '1');
    mkdirSync(segDir, { recursive: true });
    const ndjsonPath = join(segDir, 'protocol.ndjson');
    const readyPath = join(rt.root, 'seq-ready.json');
    const dbPath = join(rt.root, 'state.sqlite');
    const initialHigh = rt.store.meta().high;
    rt.close();

    const child = spawn(process.execPath, [workerPath, 'event_seq_advancing', dbPath, r.id, ndjsonPath, readyPath], { stdio: 'ignore' });
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      await until(() => existsSync(readyPath), 5_000);
      exit = await killAndWait(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    expect(exit.signal).toBe('SIGKILL');
    expect(exit.code).toBeNull();

    const reopened = new Store(dbPath);
    try {
      const highBefore = reopened.meta().high;
      expect(highBefore).toBeGreaterThan(initialHigh);

      const events = reopened.eventsSince(0, 1000).events;
      expect(events.map(e => e.seq)).toEqual(Array.from({ length: highBefore }, (_, i) => i + 1));
      expect(events.every(e => !('uncommitted' in e.data))).toBe(true);

      const c = cursor(reopened, r.id, 1);
      expect(c.lastSeq).toBe(10);
      const consumedCount = Number(reopened.db.prepare('SELECT COUNT(*) n FROM consumed WHERE run_id=? AND segment=1').get(r.id)?.n);
      expect(consumedCount).toBe(10);
      expect(reopened.get(r.id).usage).toMatchObject({ input_tokens: 100, steps: 9 });

      // Re-ingesting the NDJSON file consumes seq 11 cleanly without duplicating 1..10
      const reingested = ingest(reopened, r.id, ndjsonPath);
      expect(reingested).toBe(1);
      const highAfter = reopened.meta().high;
      expect(highAfter).toBeGreaterThan(highBefore);
      expect(cursor(reopened, r.id, 1).lastSeq).toBe(11);
      expect(Number(reopened.db.prepare('SELECT COUNT(*) n FROM consumed WHERE run_id=? AND segment=1').get(r.id)?.n)).toBe(11);
      expect(reopened.get(r.id).usage).toMatchObject({ input_tokens: 110, steps: 10 });
      const allEvents = reopened.eventsSince(0, 1000).events;
      expect(allEvents.map(e => e.seq)).toEqual(Array.from({ length: highAfter }, (_, i) => i + 1));

      // Sequence gap on NDJSON must mark protocolViolation and record a diagnostic
      appendFileSync(
        ndjsonPath,
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: { seq: 13, ts: new Date(0).toISOString(), type: 'usage', data: { ...emptyUsage(), input_tokens: 130, steps: 12 } },
        }) + '\n',
      );
      expect(ingest(reopened, r.id, ndjsonPath)).toBe(0);
      expect(reopened.get(r.id).protocolViolation).toContain('sequence_gap_or_invalid_first_event');
      const diag = reopened.db
        .prepare("SELECT kind, payload FROM diagnostics WHERE run_id=? AND kind='protocol_violation' ORDER BY id DESC LIMIT 1")
        .get(r.id) as { kind: string; payload: string } | undefined;
      expect(diag?.kind).toBe('protocol_violation');
      expect(JSON.parse(diag!.payload).error).toContain('sequence_gap_or_invalid_first_event');
    } finally {
      reopened.close();
    }
  });

  it('SIGKILL of daemon allows a new Runtime to recover and control the surviving live run', async () => {
    const root = makeTempRoot('mac-fault-daemon-');
    const ws = join(root, 'workspace');
    mkdirSync(ws, { recursive: true });

    const daemon = spawn(process.execPath, [workerPath, 'daemon_live_run', root, ws], { stdio: 'ignore' });
    let info: { runId: string; shim: { pid: number; start: string; boot: string }; endpoint: { pid: number; start: string; boot: string } };
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      await until(() => existsSync(join(root, 'ready.json')), 5_000);
      info = jsonFile<typeof info>(join(root, 'ready.json'))!;
      exit = await killAndWait(daemon);
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    }
    expect(exit.signal).toBe('SIGKILL');
    expect(alive(info.shim)).toBe(true);
    expect(alive(info.endpoint)).toBe(true);

    const recovered = new Runtime({ root, preserve: markerPreserver, timing: { exitMs: 120, killMs: 70, graceMs: 70 } });
    allocations.push({ root, runtime: recovered });
    await recovered.recover();

    expect(recovered.epoch).toBeGreaterThan(1);
    expect(recovered.store.get(info.runId).state).toBe('running');
    expect(recovered.host.facts(recovered.store.get(info.runId).runDir, 1).endpointAlive).toBe(true);

    recovered.stop(info.runId);
    const cancelled = await state(recovered, info.runId, 'cancelled');
    expect(cancelled.reason).toBe('supervisor_cancel');
    expect(recovered.host.facts(cancelled.runDir, 1).groupAlive).toBe(false);

    const events = recovered.store.eventsSince(0, 1000).events;
    expect(events.map(e => e.seq)).toEqual(Array.from({ length: recovered.store.meta().high }, (_, i) => i + 1));
  });

  it('SIGKILL during takeover persistence/fencing window prevents duplicate launch, duplicate consumption, and preserves control', async () => {
    const root = makeTempRoot('mac-fault-takeover-');
    const ws = join(root, 'workspace');
    mkdirSync(ws, { recursive: true });

    // Daemon 1 launches a live run and is SIGKILLed.
    const daemon1 = spawn(process.execPath, [workerPath, 'daemon_live_run', root, ws], { stdio: 'ignore' });
    let info: { runId: string; shim: { pid: number; start: string; boot: string }; endpoint: { pid: number; start: string; boot: string } };
    let exit1: { code: number | null; signal: NodeJS.Signals | null };
    try {
      await until(() => existsSync(join(root, 'ready.json')), 5_000);
      info = jsonFile<typeof info>(join(root, 'ready.json'))!;
      exit1 = await killAndWait(daemon1);
    } finally {
      if (daemon1.exitCode === null && daemon1.signalCode === null) daemon1.kill('SIGKILL');
    }
    expect(exit1.signal).toBe('SIGKILL');

    // Daemon 2 enters recover() takeover critical window and is SIGKILLed before committing.
    const takeoverReadyPath = join(root, 'takeover-ready.json');
    const daemon2 = spawn(process.execPath, [workerPath, 'daemon_takeover_window', root, takeoverReadyPath], { stdio: 'ignore' });
    let takeoverInfo: { epoch: number; runId: string; pid: number };
    let exit2: { code: number | null; signal: NodeJS.Signals | null };
    try {
      await until(() => existsSync(takeoverReadyPath), 5_000);
      takeoverInfo = jsonFile<typeof takeoverInfo>(takeoverReadyPath)!;
      exit2 = await killAndWait(daemon2);
    } finally {
      if (daemon2.exitCode === null && daemon2.signalCode === null) daemon2.kill('SIGKILL');
    }
    expect(exit2.signal).toBe('SIGKILL');
    expect(exit2.code).toBeNull();
    expect(alive(info.shim)).toBe(true);
    expect(alive(info.endpoint)).toBe(true);

    // Daemon 3 recovers cleanly after Daemon 2 crashed mid-takeover.
    const recovered = new Runtime({ root, preserve: markerPreserver, timing: { exitMs: 120, killMs: 70, graceMs: 70 } });
    allocations.push({ root, runtime: recovered });
    await recovered.recover();

    expect(recovered.epoch).toBeGreaterThan(takeoverInfo.epoch);
    const run = recovered.store.get(info.runId);
    expect(run.state).toBe('running');
    expect(run.segment).toBe(1);
    expect(run.launchAttempts).toBe(0);

    const facts = recovered.host.facts(run.runDir, 1);
    expect(facts.shimAlive).toBe(true);
    expect(facts.endpointAlive).toBe(true);
    expect(facts.status?.shim).toEqual(info.shim);

    const dupConsumed = recovered.store.db
      .prepare('SELECT seq, COUNT(*) c FROM consumed WHERE run_id=? AND segment=1 GROUP BY seq HAVING c > 1')
      .all(info.runId);
    expect(dupConsumed).toHaveLength(0);

    recovered.stop(info.runId);
    const cancelled = await state(recovered, info.runId, 'cancelled');
    expect(cancelled.reason).toBe('supervisor_cancel');
    expect(recovered.host.facts(cancelled.runDir, 1).groupAlive).toBe(false);

    const events = recovered.store.eventsSince(0, 1000).events;
    expect(events.map(e => e.seq)).toEqual(Array.from({ length: recovered.store.meta().high }, (_, i) => i + 1));
  });
});
