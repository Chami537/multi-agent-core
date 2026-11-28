import { appendFileSync, closeSync, fdatasyncSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../dist/store/database.js';
import { ingest } from '../../dist/store/ingest.js';
import { Runtime } from '../../dist/core/runtime.js';
import { emptyUsage } from '../../dist/core/types.js';
import { bootId, durableJson, tryLock } from '../../dist/host/process.js';

const [mode, ...args] = process.argv.slice(2);

function frame(seq, type, data = {}) {
  return JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { seq, ts: new Date(0).toISOString(), type, data } }) + '\n';
}

if (mode === 'wal_write_mid_tx') {
  const [dbPath, readyPath, workspace] = args;
  const store = new Store(dbPath);
  for (let i = 0; i < 5; i++) {
    const id = `committed_${i}`;
    store.transaction(() => {
      store.put({
        id, projectId: 'default', taskId: 'default', account: 'fake', runner: 'fake',
        state: 'queued', reason: null, version: 1, inputMode: 'none', role: 'dev',
        model: 'fake-high', reasoningEffort: 'default', reservation: false, segment: 0,
        launchAttempts: 0, intent: null, finalizing: false, stop: null, candidate: null,
        usage: { ...emptyUsage(), unknown_runs: 0 }, segmentUsage: {}, previousSteps: 0,
        protocolViolation: null, timeouts: { total_s: null, idle_s: null, waiting_s: null },
        clocks: { totalMs: 0, runningSince: null, idleSince: null, waitingSince: null },
        preservation: { state: 'not_required', kind: null, error: null, sha: null },
        protected: false, messages: [], resumeToken: null, cleanupTermAt: null,
        outputDrained: false, groupEmpty: false, workspaceHead: null, hadWorkEvents: false,
        workspace, runDir: workspace, prompt: '', maxSteps: null,
      });
      store.emit('run.created', { index: i }, null);
    });
  }
  store.transaction(() => {
    store.put({
      id: 'uncommitted_run', projectId: 'default', taskId: 'default', account: 'fake', runner: 'fake',
      state: 'queued', reason: null, version: 1, inputMode: 'none', role: 'dev',
      model: 'fake-high', reasoningEffort: 'default', reservation: false, segment: 0,
      launchAttempts: 0, intent: null, finalizing: false, stop: null, candidate: null,
      usage: { ...emptyUsage(), unknown_runs: 0 }, segmentUsage: {}, previousSteps: 0,
      protocolViolation: null, timeouts: { total_s: null, idle_s: null, waiting_s: null },
      clocks: { totalMs: 0, runningSince: null, idleSince: null, waitingSince: null },
      preservation: { state: 'not_required', kind: null, error: null, sha: null },
      protected: false, messages: [], resumeToken: null, cleanupTermAt: null,
      outputDrained: false, groupEmpty: false, workspaceHead: null, hadWorkEvents: false,
      workspace, runDir: workspace, prompt: '', maxSteps: null,
    });
    store.emit('run.created', { uncommitted: true }, null);
    durableJson(readyPath, { committed: 5 });
    // Hold transaction open until SIGKILL arrives.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  });
} else if (mode === 'ndjson_append_mid_line') {
  const [segmentDir, readyPath] = args;
  const release = tryLock(join(segmentDir, 'writer.lock'));
  if (!release) throw new Error('lock_failed');
  const ndjsonPath = join(segmentDir, 'protocol.ndjson');
  const complete =
    frame(1, 'session.started', { native_session_id: null, native_version: null, model: null, reasoning_effort: {} }) +
    frame(2, 'usage', { ...emptyUsage(), input_tokens: 10, steps: 1 }) +
    frame(3, 'message', { role: 'assistant', text: 'partial-test', final: false, truncated: false });
  const partial = '{"jsonrpc":"2.0","method":"event","params":{"seq":4,"ts":"1970-01-01T00:00:00.000Z","type":"message"';
  const fd = openSync(ndjsonPath, 'a');
  writeSync(fd, complete);
  fdatasyncSync(fd);
  writeSync(fd, partial);
  closeSync(fd);
  durableJson(readyPath, {
    shim: { pid: process.pid, start: '0', boot: bootId() },
    pgid: null,
    boot: bootId(),
    completeBytes: Buffer.byteLength(complete),
  });
  setInterval(() => {}, 1_000);
} else if (mode === 'event_seq_advancing') {
  const [dbPath, runId, ndjsonPath, readyPath] = args;
  const store = new Store(dbPath);
  writeFileSync(ndjsonPath, frame(1, 'session.started', { native_session_id: null, native_version: null, model: null, reasoning_effort: {} }));
  ingest(store, runId, ndjsonPath);
  for (let seq = 2; seq <= 200; seq++) {
    appendFileSync(ndjsonPath, frame(seq, 'usage', { ...emptyUsage(), input_tokens: seq * 10, steps: seq - 1 }));
    ingest(store, runId, ndjsonPath);
    if (seq === 10) {
      durableJson(readyPath, { seq });
    }
  }
} else if (mode === 'daemon_live_run') {
  const [root, workspace] = args;
  const runtime = new Runtime({
    root,
    preserve: async (_run, kind) => ({ state: 'saved', kind, sha: null, error: null }),
    timing: { exitMs: 120, killMs: 70, graceMs: 70 },
  });
  const run = runtime.create({
    workspace,
    prompt: '```mac-fake\n{"schema":"mac.fake-scenario/0.2","steps":[{"op":"sleep","ms":30000},{"op":"complete"}]}\n```',
  });
  runtime.start(run.id);
  const timer = setInterval(async () => {
    await runtime.tick();
    const facts = runtime.host.facts(run.runDir, 1);
    if (facts.endpointAlive && facts.shimAlive && runtime.store.meta().high >= 3) {
      durableJson(join(root, 'ready.json'), {
        runId: run.id,
        shim: facts.status.shim,
        endpoint: facts.status.endpoint,
      });
    }
  }, 20);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    runtime.close();
    process.exit(0);
  });
} else {
  throw new Error(`unknown_mode: ${mode}`);
}
