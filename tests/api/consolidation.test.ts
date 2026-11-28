import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiServer, defaultFakeCapabilities } from '../../dist/api/index.js';
import { handleEventsEndpoint } from '../../dist/api/events.js';
import { executeWorktreeRelease, getReleaseRecord, saveReleaseRecord, verifyWorktreePreservation } from '../../dist/api/worktree.js';
import { Runtime } from '../../dist/core/runtime.js';
import { cursor, ingest } from '../../dist/store/ingest.js';
import { markerPreserver, prompt, state, until } from '../helpers/runtime.js';

describe('D2A consolidation: real fault windows and state invariants', () => {
  let root: string, repo: string, runtime: Runtime, api: ReturnType<typeof createApiServer>, url: string;
  let key = 0;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 5000 }).trim();
  const headers = (idem = `k-${++key}`) => ({ Authorization: 'Bearer test', 'Supervisor-Protocol': '0.2', 'Content-Type': 'application/json', 'Idempotency-Key': idem });
  const projects = () => [{ id: 'p', name: 'P', default_branch: 'main', workspace_path: repo, max_level: 'L3' as const, forbidden: [], limits: { concurrency: 4 }, defaults: { timeouts: { total_s: 600, idle_s: 120 }, reclaim_after_s: 3600 } }];
  const newApi = () => {
    const runners = defaultFakeCapabilities();
    runners[0]!.features.interaction.input = 'stdin';
    runners[0]!.features.interaction.holds_slot_while_waiting = true;
    return createApiServer({ runtime, tokens: [{ token: 'test', token_id: 't', principal: 'u', projects: ['p'], scopes: ['read', 'submit', 'control', 'decide'] }], projects: projects(), runners });
  };
  const post = (path: string, body: unknown, idem?: string) => fetch(`${url}/v0/${path}`, { method: 'POST', headers: headers(idem), body: JSON.stringify(body) });
  const meta = (id: string) => JSON.parse((runtime.store.db.prepare('SELECT payload FROM api_runs WHERE id=?').get(id) as { payload: string }).payload);
  const task = (id: string) => JSON.parse((runtime.store.db.prepare('SELECT payload FROM api_tasks WHERE id=?').get(id) as { payload: string }).payload);
  const events = () => runtime.store.eventsSince(0, 1000).events;
  const spec = (extra = {}) => ({ role: 'dev', title: 'R', instructions: prompt('ok'), runner: 'fake', model: '@high', reasoning_effort: 'default', tier_rationale: 'test', ...extra });
  async function create(extra = {}, count = 1, level = 'L2') {
    const response = await post('tasks', { project_id: 'p', title: 'T', goal: 'G', level, runs: Array.from({ length: count }, () => spec(extra)) });
    expect(response.status).toBe(201);
    return await response.json() as { task: { id: string }; runs: { id: string; model: any; reasoning_effort: any }[] };
  }
  async function done() {
    const created = await create();
    const id = created.runs[0]!.id;
    runtime.start(id); await state(runtime, id, 'done');
    return { id, taskId: created.task.id, run: runtime.store.get(id) };
  }
  async function review(taskId: string, source: { id: string; sha: string }, invalid = false) {
    const response = await post(`tasks/${taskId}/runs`, { runs: [spec()] }); expect(response.status).toBe(201);
    const id = (await response.json()).runs[0].id;
    // Internal receipt fixture: public review dispatch remains a Phase 4/501
    // boundary. Exercise the host validator used by rulings without widening it.
    runtime.store.transaction(() => {
      const r = runtime.store.get(id); r.role = 'review'; runtime.store.put(r);
      const m = meta(id); m.role = 'review'; m.review_of = { run_id: source.id, sha: source.sha };
      runtime.store.db.prepare('UPDATE api_runs SET payload=? WHERE id=?').run(JSON.stringify(m), id);
    });
    const dir = join(runtime.store.get(id).runDir, 'artifacts'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ schema: 'mac.verdict/0.2', reviewed: { run_id: source.id, sha: source.sha }, overall: 'PASS', summary: 'reviewed', items: [{ id: 'V1', title: 'check', result: invalid ? 'fail' : 'pass' }] }));
    runtime.start(id); await state(runtime, id, invalid ? 'failed' : 'done'); return id;
  }
  async function reopen() {
    await api.close(); runtime.close();
    runtime = new Runtime({ root: join(root, 'rt'), preserve: markerPreserver, globalLimit: 4, timing: { exitMs: 120, killMs: 70, graceMs: 70 } });
    api = newApi(); url = (await api.listen()).url;
  }
  beforeEach(async () => {
    key = 0; root = mkdtempSync(join(tmpdir(), 'mac-d2a-')); repo = join(root, 'repo'); mkdirSync(repo);
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'README.md'), 'init\n'); git('add', '.'); git('commit', '-m', 'init');
    runtime = new Runtime({ root: join(root, 'rt'), preserve: markerPreserver, globalLimit: 4, timing: { exitMs: 120, killMs: 70, graceMs: 70 } });
    api = newApi(); url = (await api.listen()).url;
  });
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks();
    // Fault tests may deliberately stop before completion. Only signal processes
    // owned by these exact run/segment identities, then let the shim drain.
    for (const run of runtime.store.list()) {
      if (run.segment && !['done', 'failed', 'cancelled', 'interrupted'].includes(run.state)) runtime.host.signal(run.runDir, run.segment, 'SIGKILL');
    }
    await api.close(); runtime.close(); rmSync(root, { recursive: true, force: true });
  });

  it.each(['messages', 'cancel', 'complete'])('R1-A/R8: %s rolls back resource, command, events and key together', async action => {
    const created = await create({ instructions: prompt('interactive:2'), interaction: 'interactive' });
    const id = created.runs[0]!.id; runtime.start(id); await state(runtime, id, 'waiting');
    const before = runtime.store.get(id), high = runtime.store.meta().high;
    const body = action === 'messages' ? { text: 'once' } : action === 'cancel' ? { reason: 'test' } : {};
    runtime.store.db.exec("CREATE TRIGGER fail_commit BEFORE UPDATE ON api_idempotency BEGIN SELECT RAISE(ABORT, 'commit_fault'); END");
    const failed = await post(`runs/${id}/${action}`, body, 'atomic');
    expect(failed.status).toBe(500);
    expect(runtime.store.get(id)).toEqual(before);
    expect(runtime.store.meta().high).toBe(high);
    expect(runtime.store.db.prepare('SELECT * FROM commands WHERE run_id=?').all(id)).toHaveLength(0);
    expect(runtime.store.db.prepare("SELECT * FROM api_idempotency WHERE idempotency_key='atomic'").all()).toHaveLength(0);
    runtime.store.db.exec('DROP TRIGGER fail_commit');
    const accepted = await post(`runs/${id}/${action}`, body, 'atomic');
    expect(accepted.status).toBe(202);
    const acceptedText = await accepted.text(), changed = runtime.store.get(id);
    expect(changed.version).toBeGreaterThan(before.version);
    if (action === 'messages') expect(changed.messages).toEqual([expect.objectContaining({ text: 'once', state: 'pending' })]);
    if (action === 'cancel') expect(changed.stop).toMatchObject({ kind: 'cancel', reason: 'test' });
    if (action === 'complete') {
      expect(changed.finalizing).toBe(true);
      expect(runtime.store.db.prepare("SELECT * FROM commands WHERE run_id=? AND method='run.complete'").all(id)).toHaveLength(1);
    }
    const afterHigh = runtime.store.meta().high;
    const replay = await post(`runs/${id}/${action}`, body, 'atomic');
    expect(replay.status).toBe(202); expect(await replay.text()).toBe(acceptedText);
    expect(runtime.store.get(id)).toEqual(changed); expect(runtime.store.meta().high).toBe(afterHigh);
    if (action === 'messages') { runtime.start(id); await state(runtime, id, 'waiting'); runtime.complete(id); }
    await state(runtime, id, action === 'cancel' ? 'cancelled' : 'done');
  });

  it('R1-A: complete delivery failure preserves first/replayed 202 and durable command recovers', async () => {
    const created = await create({ instructions: prompt('interactive:1'), interaction: 'interactive' });
    const id = created.runs[0]!.id; runtime.start(id); await state(runtime, id, 'waiting');
    const delivery = vi.spyOn(runtime, 'flushPendingCommands').mockImplementation(() => { throw new Error('delivery_fault'); });
    const first = await post(`runs/${id}/complete`, {}, 'deliver');
    expect(first.status).toBe(202); const text = await first.text();
    expect(delivery).toHaveBeenCalledOnce(); expect(runtime.store.get(id).finalizing).toBe(true);
    expect(runtime.store.db.prepare('SELECT delivered FROM commands WHERE run_id=?').get(id)).toMatchObject({ delivered: 0 });
    const replay = await post(`runs/${id}/complete`, {}, 'deliver');
    expect(replay.status).toBe(202); expect(await replay.text()).toBe(text); expect(delivery).toHaveBeenCalledOnce();
    delivery.mockRestore(); await reopen(); await runtime.recover(); await state(runtime, id, 'done');
    expect(runtime.store.db.prepare('SELECT delivered FROM commands WHERE run_id=?').get(id)).toMatchObject({ delivered: 1 });
  });

  it.each(['cancel', 'close'])('R1-A: task %s rolls back all runs when the second write fails', async action => {
    const created = await create({}, 2), ids = created.runs.map(r => r.id);
    const before = ids.map(id => runtime.store.get(id)), beforeTask = task(created.task.id), high = runtime.store.meta().high;
    runtime.store.db.exec(`CREATE TRIGGER fail_second BEFORE UPDATE ON runs WHEN NEW.id='${ids[1]}' BEGIN SELECT RAISE(ABORT, 'second_run_fault'); END`);
    const body = action === 'cancel' ? { reason: 'batch' } : { outcome: 'abandoned', cancel_open_runs: true };
    expect((await post(`tasks/${created.task.id}/${action}`, body, 'batch')).status).toBe(500);
    expect(ids.map(id => runtime.store.get(id))).toEqual(before); expect(task(created.task.id)).toEqual(beforeTask);
    expect(runtime.store.meta().high).toBe(high);
    expect(runtime.store.db.prepare("SELECT * FROM api_idempotency WHERE idempotency_key='batch'").all()).toHaveLength(0);
    runtime.store.db.exec('DROP TRIGGER fail_second');
    expect((await post(`tasks/${created.task.id}/${action}`, body, 'batch')).status).toBe(200);
    expect(ids.map(id => runtime.store.get(id).state)).toEqual(['cancelled', 'cancelled']);
    expect(task(created.task.id).state).toBe(action === 'cancel' ? 'cancelled' : 'closed');
  });

  it.each(['cancel', 'close'])('R1-A: task %s rolls back earlier cancellations when a later run refuses cancellation', async action => {
    const created = await create({}, 2), ids = created.runs.map(r => r.id);
    runtime.store.transaction(() => {
      const r = runtime.store.get(ids[1]!); r.state = 'running'; r.reservation = true; r.finalizing = true;
      r.candidate = { at: Date.now(), stopPrecedes: false, source: 'runner', data: { outcome: 'completed' } as any }; runtime.store.put(r);
    });
    const before = ids.map(id => runtime.store.get(id)), beforeTask = task(created.task.id), high = runtime.store.meta().high;
    const response = await post(`tasks/${created.task.id}/${action}`, action === 'cancel' ? {} : { outcome: 'abandoned', cancel_open_runs: true });
    expect(response.status).toBe(409); expect((await response.json()).error.details.phase).toBe('finalizing');
    expect(ids.map(id => runtime.store.get(id))).toEqual(before); expect(task(created.task.id)).toEqual(beforeTask); expect(runtime.store.meta().high).toBe(high);
  });

  it.each([[], null, 'text', true, 12])('R1-B: deterministic non-object JSON %j owns its key', async body => {
    const first = await post('tasks', body, 'non-object'); expect(first.status).toBe(400); const text = await first.text();
    const replay = await post('tasks', body, 'non-object'); expect(replay.status).toBe(400);
    expect(replay.headers.get('idempotent-replayed')).toBe('true'); expect(await replay.text()).toBe(text);
    const valid = await post('tasks', { project_id: 'p', title: 'T', goal: 'G', level: 'L2' }, 'non-object');
    expect(valid.status).toBe(409); expect((await valid.json()).error.code).toBe('idempotency_conflict');
    expect(runtime.store.list()).toHaveLength(0); expect(runtime.store.db.prepare('SELECT * FROM api_tasks').all()).toHaveLength(0);
  });

  it.each([
    [{ base: { kind: 'commit', sha: 123 } }, 'runs[0].base.sha'],
    [{ base: { kind: 'branch', ref: [] } }, 'runs[0].base.ref'],
    [{ base: { kind: 'wip', sha: null } }, 'runs[0].base.sha'],
    [{ base: { kind: 'run', run_id: 1 } }, 'runs[0].base.run_id'],
    [{ context: { notes: [] } }, 'runs[0].context.notes'],
    [{ degrade: [{ capability: ['read_only'], mode: 'advisory', reason: 'x' }] }, 'runs[0].degrade[0].capability'],
    [{ fallbacks: [{ runner: 'fake', base: { kind: 'commit', sha: 123 } }] }, 'runs[0].fallbacks[0].base.sha'],
  ])('R3-A: nested invalid types are 400 with the exact field path (%j)', async (extra, path) => {
    const response = await post('tasks', { project_id: 'p', title: 'T', goal: 'G', level: 'L2', runs: [spec(extra)] });
    expect(response.status).toBe(400); expect((await response.json()).error.details.violations).toContainEqual(expect.objectContaining({ path }));
    expect(runtime.store.list()).toHaveLength(0); expect(events()).toHaveLength(0);
  });

  it('R3-C: rework uses terminal head instead of WIP and applies legal overrides', async () => {
    const { id, run } = await done(); const head = run.workspaceHead;
    git('commit', '--allow-empty', '-m', 'different-wip'); const wip = git('rev-parse', 'HEAD'); expect(wip).not.toBe(head);
    runtime.store.transaction(() => { const r = runtime.store.get(id); r.preservation.sha = wip; runtime.store.put(r); });
    const response = await post(`runs/${id}/continue`, { mode: 'rework', overrides: { critical: true, priority: 50, timeouts: { idle_s: 33 }, instructions_append: 'append' } });
    expect(response.status).toBe(201); const next = (await response.json()).run;
    expect(next.base.sha).toBe(head); expect(next.continues.sha).toBe(head); expect(next.critical).toBe(true);
    expect(next.timeouts.idle_s).toBe(33); expect(next.instructions).toContain('append'); expect(meta(next.id).critical).toBe(true);
    runtime.start(next.id); await state(runtime, next.id, 'done');
    expect(runtime.store.get(next.id).workspaceHead).toBe(head);
  });

  it('R4-D: in_place checks out its declared branch, holds the root lease and restores the original HEAD', async () => {
    const base = git('rev-parse', 'HEAD'); git('commit', '--allow-empty', '-m', 'original-head');
    const original = git('rev-parse', 'HEAD');
    const created = await create({ workspace: 'in_place', base: { kind: 'commit', sha: base }, instructions: prompt('interactive:1'), interaction: 'interactive' }, 2, 'L3');
    const [id, other] = created.runs.map(r => r.id); runtime.start(id!); await state(runtime, id!, 'waiting');
    expect(git('symbolic-ref', '--short', 'HEAD')).toBe(`mac/${id}`); expect(git('rev-parse', 'HEAD')).toBe(base);
    expect(runtime.store.get(id!).workspace).toBe(repo); expect(meta(id!).branch).toBe(`mac/${id}`);
    expect(() => runtime.start(other!)).toThrow('in_place_lease_conflict');
    runtime.complete(id!); await state(runtime, id!, 'done');
    expect(git('symbolic-ref', '--short', 'HEAD')).toBe('main'); expect(git('rev-parse', 'HEAD')).toBe(original);
    runtime.start(other!); await state(runtime, other!, 'waiting'); runtime.complete(other!); await state(runtime, other!, 'done');
    expect(git('symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it.each(['worktree', 'in_place'])('NEW-1: %s preparation survives metadata failure and daemon reopen', async mode => {
    const created = await create({ workspace: mode }, 1, mode === 'in_place' ? 'L3' : 'L2'), id = created.runs[0]!.id;
    runtime.store.db.exec(`CREATE TRIGGER fail_metadata BEFORE UPDATE ON api_runs WHEN NEW.id='${id}' BEGIN SELECT RAISE(ABORT, 'metadata_fault'); END`);
    expect(() => runtime.start(id)).toThrow('metadata_fault');
    expect(runtime.store.get(id)).toMatchObject({ state: 'queued', segment: 0, intent: null });
    const prep = JSON.parse((runtime.store.db.prepare('SELECT payload FROM api_start_preparations WHERE run_id=?').get(id) as { payload: string }).payload);
    expect(prep).toMatchObject({ branch: `mac/${id}`, workspace: mode === 'worktree' ? join(runtime.store.get(id).runDir, 'worktree') : repo, mode });
    expect(git('rev-parse', `refs/heads/mac/${id}`)).toBe(prep.base_sha); expect(existsSync(prep.workspace)).toBe(true);
    // A retry fails only at the injected metadata write, never branch-already-exists.
    expect(() => runtime.start(id)).toThrow('metadata_fault');
    runtime.store.db.exec('DROP TRIGGER fail_metadata'); await reopen();
    expect(runtime.store.get(id)).toMatchObject({ state: 'running', segment: 1 }); await state(runtime, id, 'done');
    expect(meta(id).base.sha).toBe(prep.base_sha); expect(runtime.store.get(id).workspace).toBe(prep.workspace);
    if (mode === 'in_place') expect(git('symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('NEW-1/R4-D: cancelling queued in_place preparation restores HEAD and releases its durable lease', async () => {
    const created = await create({ workspace: 'in_place' }, 2, 'L3'), [id, other] = created.runs.map(r => r.id);
    runtime.store.db.exec(`CREATE TRIGGER fail_metadata BEFORE UPDATE ON api_runs WHEN NEW.id='${id}' AND json_extract(NEW.payload, '$.started_at') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'metadata_fault'); END`);
    expect(() => runtime.start(id!)).toThrow('metadata_fault'); expect(git('symbolic-ref', '--short', 'HEAD')).toBe(`mac/${id}`);
    expect(() => runtime.start(other!)).toThrow('in_place_lease_conflict');
    expect((await post(`runs/${id}/cancel`, { reason: 'cancel-preparation' })).status).toBe(200);
    expect(runtime.store.get(id!).state).toBe('cancelled'); expect(git('symbolic-ref', '--short', 'HEAD')).toBe('main');
    runtime.store.db.exec('DROP TRIGGER fail_metadata'); runtime.start(other!); await state(runtime, other!, 'done');
  });

  it('NEW-1: an intent persistence failure performs no Git mutation', async () => {
    const created = await create(), id = created.runs[0]!.id;
    runtime.store.db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON api_start_preparations BEGIN SELECT RAISE(ABORT, 'intent_fault'); END");
    expect(() => runtime.start(id)).toThrow('intent_fault');
    expect(git('branch', '--list', `mac/${id}`)).toBe(''); expect(existsSync(join(runtime.store.get(id).runDir, 'worktree'))).toBe(false);
    expect(runtime.store.db.prepare('SELECT * FROM api_start_preparations').all()).toHaveLength(0);
    runtime.store.db.exec('DROP TRIGGER fail_intent'); runtime.start(id); await state(runtime, id, 'done');
  });

  it('R5: queued resolution is null, start records exact native input, reports emit versioned ledger events', async () => {
    const created = await create({ reasoning_effort: 'low' }), id = created.runs[0]!.id;
    expect(created.runs[0]!.model).toMatchObject({ requested: '@high', resolved: null, effective: null });
    expect(created.runs[0]!.reasoning_effort).toMatchObject({ requested: 'low', resolved_native: null, effective: null });
    const launchCall = vi.spyOn(runtime.host, 'launch');
    runtime.start(id); const running = await (await fetch(`${url}/v0/runs/${id}`, { headers: headers() })).json();
    expect(running.model).toMatchObject({ resolved: 'fake-high', effective: null });
    expect(running.reasoning_effort).toMatchObject({ resolved_native: 'l', effective: null });
    expect(launchCall.mock.calls[0]![0].start.reasoning_effort.native).toBe(running.reasoning_effort.resolved_native);
    await state(runtime, id, 'done');
    const reports = events().filter(e => e.run_id === id && e.type === 'run.model_effective');
    expect(reports.length).toBeGreaterThanOrEqual(2);
    expect(reports[0]!.data).toMatchObject({ model: { requested: '@high', resolved: 'fake-high', effective: 'fake-high' }, reasoning_effort: { resolved_native: 'l', effective: 'low' } });
    expect(Number(reports[1]!.data.version)).toBeGreaterThan(Number(reports[0]!.data.version));
    expect(runtime.store.get(id).version).toBeGreaterThan(Number(reports[1]!.data.version));
  });

  it('R5: model.changed updates effective values with a versioned event in the cursor transaction', async () => {
    const created = await create({ reasoning_effort: 'low' }), id = created.runs[0]!.id;
    vi.spyOn(runtime.host, 'launch').mockImplementation(() => {}); runtime.start(id);
    const before = runtime.store.get(id), high = runtime.store.meta().high;
    const file = join(root, 'reports.ndjson');
    const frames = [
      { type: 'session.started', data: { native_session_id: null, native_version: null, model: { effective: 'fake-high', effective_source: 'native_reported' }, reasoning_effort: { effective: 'low', requested_native: 'lie', effective_source: 'native_reported' } } },
      { type: 'model.changed', data: { model: { effective: 'fallback-model', effective_source: 'native_reported' }, reasoning_effort: { effective: 'high', effective_source: 'native_reported' }, reason: 'fallback' } },
    ];
    writeFileSync(file, frames.map((frame, i) => JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { seq: i + 1, ts: new Date().toISOString(), ...frame } })).join('\n') + '\n');
    runtime.store.db.exec("CREATE TRIGGER fail_model_event BEFORE INSERT ON events WHEN json_extract(NEW.payload, '$.type')='run.model_effective' BEGIN SELECT RAISE(ABORT, 'model_event_fault'); END");
    expect(() => ingest(runtime.store, id, file)).toThrow('model_event_fault');
    expect(runtime.store.get(id)).toEqual(before); expect(runtime.store.meta().high).toBe(high); expect(cursor(runtime.store, id, 1).offset).toBe(0);
    runtime.store.db.exec('DROP TRIGGER fail_model_event'); expect(ingest(runtime.store, id, file)).toBe(2);
    const changed = runtime.store.get(id); expect(changed.reportedModel!.effective).toBe('fallback-model'); expect(changed.reportedEffort!.effective).toBe('high');
    const reports = events().filter(e => e.type === 'run.model_effective'); expect(reports).toHaveLength(2);
    expect(changed.version).toBeGreaterThanOrEqual(Number(reports[1]!.data.version));
    expect(reports[1]!.data).toMatchObject({ model: { effective: 'fallback-model', mismatch: true }, reasoning_effort: { effective: 'high', resolved_native: 'l', mismatch: true } });
    expect(Number(reports[1]!.data.version)).toBeGreaterThan(Number(reports[0]!.data.version));
    const count = events().length; expect(ingest(runtime.store, id, file)).toBe(0); expect(events()).toHaveLength(count);
  });

  it('R7-A/R8: Git reference commit followed by progress-write failure recovers with progress still false', async () => {
    const { id, run } = await done(), head = run.workspaceHead!; git('branch', 'keep', head);
    const checked = verifyWorktreePreservation({ repoRoot: repo, run, runBranch: `mac/${id}`, runBranchPrefix: 'mac', preservation: { kind: 'reachable_from', ref: 'refs/heads/keep' } });
    expect(checked.ok).toBe(true); if (!checked.ok) throw new Error(checked.message);
    runtime.store.transaction(() => saveReleaseRecord(runtime.store, id, { release: { state: 'pending', requested_at: new Date().toISOString(), released_at: null, error: null }, verified: checked.verified, progress: { ref_tx_done: false, dir_removed: false } }));
    runtime.store.db.exec("CREATE TRIGGER fail_progress BEFORE UPDATE ON api_worktree_releases WHEN json_extract(NEW.payload, '$.progress.ref_tx_done')=1 BEGIN SELECT RAISE(ABORT, 'progress_fault'); END");
    await expect(executeWorktreeRelease({ store: runtime.store, repoRoot: repo, run, verified: checked.verified })).rejects.toThrow('progress_fault');
    expect(git('branch', '--list', `mac/${id}`)).toBe(''); expect(git('rev-parse', 'keep')).toBe(head);
    expect(existsSync(run.workspace)).toBe(true); expect(getReleaseRecord(runtime.store, id)!.progress!.ref_tx_done).toBe(false);
    runtime.store.db.exec('DROP TRIGGER fail_progress'); await reopen();
    expect(existsSync(run.workspace)).toBe(false); expect(getReleaseRecord(runtime.store, id)!.release.state).toBe('completed');
    expect(getReleaseRecord(runtime.store, id)!.progress).toEqual({ ref_tx_done: true, dir_removed: true });
    expect(events().filter(e => e.run_id === id && e.type === 'run.updated').at(-1)!.data.changes).toMatchObject({ release: { state: 'completed' } });
  });

  it('R7-C/R8: moving K to a descendant after verification aborts without deleting B or its directory', async () => {
    const { id, run } = await done(), head = run.workspaceHead!; git('branch', 'keep', head);
    const checked = verifyWorktreePreservation({ repoRoot: repo, run, runBranch: `mac/${id}`, runBranchPrefix: 'mac', preservation: { kind: 'reachable_from', ref: 'refs/heads/keep' } });
    if (!checked.ok) throw new Error(checked.message);
    runtime.store.transaction(() => saveReleaseRecord(runtime.store, id, { release: { state: 'pending', requested_at: new Date().toISOString(), released_at: null, error: null }, verified: checked.verified, progress: { ref_tx_done: false, dir_removed: false } }));
    git('commit', '--allow-empty', '-m', 'advance-keep'); const changedKeep = git('rev-parse', 'HEAD'); git('update-ref', 'refs/heads/keep', changedKeep);
    git('merge-base', '--is-ancestor', head, changedKeep); // K still contains T: equality is the required guard.
    await executeWorktreeRelease({ store: runtime.store, repoRoot: repo, run, verified: checked.verified });
    expect(getReleaseRecord(runtime.store, id)!.release).toMatchObject({ state: 'aborted', error: { reason: 'preservation_ref_changed' } });
    expect(git('rev-parse', `mac/${id}`)).toBe(head); expect(git('rev-parse', 'keep')).toBe(changedKeep); expect(existsSync(run.workspace)).toBe(true);
    expect(runtime.store.get(id).version).toBeGreaterThan(run.version);
  });

  it('R8: SSE retention reset clears both actual interval handles and stops polling', () => {
    vi.useFakeTimers();
    const req = new EventEmitter() as any; req.headers = { accept: 'text/event-stream' };
    const res = new EventEmitter() as any; res.writeHead = vi.fn(); res.write = vi.fn(); res.end = vi.fn();
    const poll = vi.spyOn(runtime.store, 'eventsSince');
    expect(vi.getTimerCount()).toBe(0);
    handleEventsEndpoint({ req, res, url: new URL('http://local/v0/events?since=0'), store: runtime.store, principal: { projects: ['p'] } as any, effectiveVersion: '0.2', requestId: 'r', extraHeaders: {}, pollMs: 10, keepaliveMs: 100 });
    expect(vi.getTimerCount()).toBe(2);
    runtime.store.transaction(() => runtime.store.db.prepare('UPDATE instance_meta SET complete_from_seq=3 WHERE id=1').run());
    vi.advanceTimersByTime(10);
    expect(res.write.mock.calls.flat().join('')).toContain('event: stream.reset'); expect(res.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0); const calls = poll.mock.calls.length; vi.advanceTimersByTime(1000); expect(poll).toHaveBeenCalledTimes(calls);
  });

  it('R6-A: rejects self/non-review evidence, unverifiable terminal heads and heads moved in Git', async () => {
    const { id, taskId, run } = await done(), subject = { run_id: id, sha: run.workspaceHead };
    const before = events().filter(e => e.type.startsWith('ruling.'));
    const self = await post(`tasks/${taskId}/rulings`, { subject, decision: 'accept', based_on: [id] });
    expect(self.status).toBe(422); expect((await self.json()).error.violations[0].rule).toBe('RULING_STALE_REVIEW');
    runtime.store.transaction(() => { const r = runtime.store.get(id); r.workspaceHead = null; runtime.store.put(r); });
    expect((await post(`tasks/${taskId}/rulings`, { subject, decision: 'accept' })).status).toBe(422);
    runtime.store.transaction(() => runtime.store.put(run));
    git('commit', '--allow-empty', '-m', 'advance'); git('update-ref', `refs/heads/mac/${id}`, git('rev-parse', 'HEAD'));
    expect((await post(`tasks/${taskId}/rulings`, { subject, decision: 'accept' })).status).toBe(422);
    expect(runtime.store.db.prepare('SELECT * FROM api_rulings').all()).toHaveLength(0); expect(events().filter(e => e.type.startsWith('ruling.'))).toEqual(before);
  });

  it('R6-A: only host-validated effective review receipts can support a ruling; SHA changes supersede them', async () => {
    const { id, taskId, run } = await done(), sha = run.workspaceHead!;
    const reviewId = await review(taskId, { id, sha });
    expect(events().find(e => e.type === 'verdict.validated' && e.run_id === reviewId)!.data).toMatchObject({ valid: true, status: 'effective', reviewed: { run_id: id, sha } });
    const invalidId = await review(taskId, { id, sha }, true);
    expect(runtime.store.get(invalidId).reason).toBe('deliverable_invalid');
    expect((await post(`tasks/${taskId}/rulings`, { subject: { run_id: id, sha }, decision: 'accept', based_on: [invalidId] })).status).toBe(422);
    const continuation = await post(`runs/${id}/continue`, { mode: 'rework' }); expect(continuation.status).toBe(201); const nextId = (await continuation.json()).run.id;
    const ruling = await post(`tasks/${taskId}/rulings`, { subject: { run_id: id, sha }, decision: 'accept', based_on: [reviewId] }); expect(ruling.status).toBe(201);
    const launch = runtime.host.launch.bind(runtime.host);
    vi.spyOn(runtime.host, 'launch').mockImplementationOnce(request => {
      execFileSync('git', ['commit', '--allow-empty', '-m', 'new-head'], { cwd: request.cwd, timeout: 5000 }); launch(request);
    });
    runtime.start(nextId); await state(runtime, nextId, 'done');
    const newSha = runtime.store.get(nextId).workspaceHead!; expect(newSha).not.toBe(sha);
    const receipt = JSON.parse((runtime.store.db.prepare('SELECT payload FROM api_verdicts WHERE run_id=?').get(reviewId) as { payload: string }).payload);
    expect(receipt.status).toBe('superseded'); expect(events().filter(e => e.type === 'verdict.superseded' && e.run_id === reviewId)).toHaveLength(1);
    const stale = await post(`tasks/${taskId}/rulings`, { subject: { run_id: nextId, sha: newSha }, decision: 'accept', based_on: [reviewId] }); expect(stale.status).toBe(422); expect((await stale.json()).error.violations[0].rule).toBe('RULING_STALE_REVIEW');
    expect(JSON.parse((runtime.store.db.prepare('SELECT payload FROM api_rulings').get() as { payload: string }).payload).status).toBe('superseded');
  });

  it('R6-A: candidate progression and ruling superseding roll back together on storage failure', async () => {
    const { id, taskId, run } = await done(), originalCandidate = meta(id).lineage.candidate;
    const continuation = await post(`runs/${id}/continue`, { mode: 'rework' }); expect(continuation.status).toBe(201);
    const nextId = (await continuation.json()).run.id;
    // The old SHA remains candidate while the new run is queued.
    const ruling = await post(`tasks/${taskId}/rulings`, { subject: { run_id: id, sha: run.workspaceHead }, decision: 'accept' });
    expect(ruling.status).toBe(201); const rulingId = (await ruling.json()).id;
    runtime.store.db.exec("CREATE TRIGGER fail_supersede BEFORE UPDATE ON api_rulings BEGIN SELECT RAISE(ABORT, 'supersede_fault'); END");
    runtime.start(nextId);
    await until(async () => { try { await runtime.tick(); } catch (error) { if (String(error).includes('supersede_fault')) return true; throw error; } return false; });
    expect(runtime.store.get(nextId).state).not.toBe('done'); expect(meta(id).lineage.candidate).toEqual(originalCandidate); expect(meta(nextId).lineage.candidate).toEqual(originalCandidate);
    expect(JSON.parse((runtime.store.db.prepare('SELECT payload FROM api_rulings WHERE id=?').get(rulingId) as { payload: string }).payload).status).toBe('effective');
    expect(events().filter(e => e.type === 'ruling.superseded')).toHaveLength(0);
    runtime.store.db.exec('DROP TRIGGER fail_supersede'); await state(runtime, nextId, 'done');
    expect(meta(id).lineage.candidate).toMatchObject({ run_id: nextId, sha: runtime.store.get(nextId).workspaceHead });
    expect(meta(nextId).lineage.candidate).toEqual(meta(id).lineage.candidate);
    const superseded = events().filter(e => e.type === 'ruling.superseded'); expect(superseded).toHaveLength(1); expect(superseded[0]!.data.version).toBe(2);
    const stale = await post(`tasks/${taskId}/rulings`, { subject: { run_id: id, sha: run.workspaceHead }, decision: 'accept' }); expect(stale.status).toBe(422);
    const valid = await post(`tasks/${taskId}/rulings`, { subject: { run_id: nextId, sha: runtime.store.get(nextId).workspaceHead }, decision: 'accept', expected_branch_version: meta(nextId).lineage.version }); expect(valid.status).toBe(201);
  });
});
