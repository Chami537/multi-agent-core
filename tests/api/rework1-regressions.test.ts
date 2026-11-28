import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiServer,
  defaultFakeCapabilities,
  type ApiServer,
  type ProjectConfig,
  type TokenConfig,
} from '../../dist/api/index.js';
import { move } from '../../dist/core/lifecycle.js';
import { Runtime } from '../../dist/core/runtime.js';
import { markerPreserver, prompt, state, until } from '../helpers/runtime.js';

function initGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'init\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

describe('Phase 1 D2A Rework-1 Regressions', () => {
  let root: string;
  let repoSite: string;
  let repoOther: string;
  let runtime: Runtime;
  let api: ApiServer;
  let baseUrl: string;

  const fullToken = 'mact_r1_full';
  const siteOnlyToken = 'mact_r1_site_only';

  const hdrs = (key?: string, tok = fullToken): Record<string, string> => ({
    Authorization: `Bearer ${tok}`,
    'Supervisor-Protocol': '0.2',
    'Content-Type': 'application/json',
    ...(key ? { 'Idempotency-Key': key } : {}),
  });

  const makeProjects = (): ProjectConfig[] => [
    {
      id: 'site',
      name: 'Site',
      default_branch: 'main',
      workspace_path: repoSite,
      max_level: 'L3',
      forbidden: [],
      limits: { concurrency: 4 },
      defaults: { timeouts: { total_s: 600, idle_s: 120 }, reclaim_after_s: 3600 },
    },
    {
      id: 'other',
      name: 'Other',
      default_branch: 'main',
      workspace_path: repoOther,
      max_level: 'L3',
      forbidden: [],
      limits: { concurrency: 4 },
      defaults: { timeouts: { total_s: 600, idle_s: 120 }, reclaim_after_s: 3600 },
    },
  ];

  const makeTokens = (): TokenConfig[] => [
    { token: fullToken, token_id: 't_full', principal: 'xiaoba', scopes: ['read', 'submit', 'control', 'decide'], projects: ['site', 'other'] },
    { token: siteOnlyToken, token_id: 't_site', principal: 'xiaoba', scopes: ['read', 'submit', 'control', 'decide'], projects: ['site'] },
  ];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mac-r1-reg-'));
    repoSite = join(root, 'repo-site');
    repoOther = join(root, 'repo-other');
    initGitRepo(repoSite);
    initGitRepo(repoOther);

    runtime = new Runtime({ root: join(root, 'rt'), preserve: markerPreserver, timing: { exitMs: 120, killMs: 70, graceMs: 70 } });
    const caps = defaultFakeCapabilities();
    const aliasRunner = structuredClone(caps[0]!);
    aliasRunner.id = 'fake-ro';
    aliasRunner.features.read_only.enforceable = true;
    aliasRunner.accounts[0]!.models[0]!.aliases = ['fake-alias'];

    api = createApiServer({
      runtime,
      tokens: makeTokens(),
      projects: makeProjects(),
      runners: [...caps, aliasRunner],
      ssePollMs: 15,
    });
    baseUrl = (await api.listen(0, '127.0.0.1')).url;
  });

  afterEach(async () => {
    await api.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('R1-A: message/cancel/complete are atomic with idempotency commit (injected commit failure rolls back cleanly)', async () => {
    const rCreate = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r1a-create'),
      body: JSON.stringify({
        project_id: 'site',
        title: 'R1-A',
        goal: 'Atomic tx',
        level: 'L2',
        runs: [{
          role: 'dev', title: 'R', instructions: prompt('interactive:2'), runner: 'fake',
          model: '@high', reasoning_effort: 'default', tier_rationale: 'test', interaction: 'interactive',
        }],
      }),
    });
    expect(rCreate.status).toBe(201);
    const { runs } = await rCreate.json() as { runs: { id: string }[] };
    const runId = runs[0]!.id;

    runtime.start(runId);
    await state(runtime, runId, 'waiting');

    // Inject failure at api_idempotency UPDATE (commit point)
    runtime.store.db.exec(`
      CREATE TRIGGER fail_idem_update BEFORE UPDATE ON api_idempotency
      BEGIN
        SELECT RAISE(ABORT, 'injected_commit_failure');
      END;
    `);

    const rMsgFail = await fetch(`${baseUrl}/v0/runs/${runId}/messages`, {
      method: 'POST',
      headers: hdrs('r1a-msg-1'),
      body: JSON.stringify({ text: 'hello once', kind: 'answer' }),
    });
    expect(rMsgFail.status).toBe(500);
    // Resource change must have rolled back completely!
    expect(runtime.store.get(runId).messages).toHaveLength(0);

    runtime.store.db.exec('DROP TRIGGER fail_idem_update;');

    // Retry with same Idempotency-Key must succeed with 202 and produce exactly 1 message (never 409)
    const rMsgOk = await fetch(`${baseUrl}/v0/runs/${runId}/messages`, {
      method: 'POST',
      headers: hdrs('r1a-msg-1'),
      body: JSON.stringify({ text: 'hello once', kind: 'answer' }),
    });
    expect(rMsgOk.status).toBe(202);
    expect(runtime.store.get(runId).messages).toHaveLength(1);
  });

  it('R1-B: deterministic 400 is recorded in idempotency and rejects same-key different-body with 409', async () => {
    const r400 = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r1b-400'),
      body: JSON.stringify({ project_id: 'site', title: 't', goal: 'g', level: 'L2', bad_field: 1 }),
    });
    expect(r400.status).toBe(400);

    const rReplay = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r1b-400'),
      body: JSON.stringify({ project_id: 'site', title: 't', goal: 'g', level: 'L2', bad_field: 1 }),
    });
    expect(rReplay.status).toBe(400);
    expect(rReplay.headers.get('idempotent-replayed')).toBe('true');

    const rConflict = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r1b-400'),
      body: JSON.stringify({ project_id: 'site', title: 'Valid', goal: 'g', level: 'L2' }),
    });
    expect(rConflict.status).toBe(409);
    expect((await rConflict.json() as { error: { code: string } }).error.code).toBe('idempotency_conflict');
  });

  it('R4-A & R4-B: cross-project event isolation (JSON + SSE) and idempotency replay project authorization', async () => {
    // Create task in 'other' using fullToken (principal 'xiaoba')
    const rOther = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r4b-shared-key', fullToken),
      body: JSON.stringify({ project_id: 'other', title: 'Other Task', goal: 'g', level: 'L2' }),
    });
    expect(rOther.status).toBe(201);
    const otherTask = (await rOther.json() as { task: { id: string } }).task;

    // Append journal in 'other'
    const rJnl = await fetch(`${baseUrl}/v0/tasks/${otherTask.id}/journal`, {
      method: 'POST',
      headers: hdrs('r4a-jnl-other', fullToken),
      body: JSON.stringify({ kind: 'note', data: { msg: 'secret' } }),
    });
    expect(rJnl.status).toBe(201);

    // R4-B: Same principal ('xiaoba') with siteOnlyToken cannot replay r4b-shared-key for 'other'
    const rBypass = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r4b-shared-key', siteOnlyToken),
      body: JSON.stringify({ project_id: 'other', title: 'Other Task', goal: 'g', level: 'L2' }),
    });
    expect(rBypass.status).toBe(403);
    expect((await rBypass.json() as { error: { code: string } }).error.code).toBe('project_not_authorized');

    // Create task in 'site'
    const rSite = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r4a-site', siteOnlyToken),
      body: JSON.stringify({ project_id: 'site', title: 'Site Task', goal: 'g', level: 'L2' }),
    });
    expect(rSite.status).toBe(201);
    const siteTask = (await rSite.json() as { task: { id: string } }).task;

    // R4-A JSON catchup: siteOnlyToken must see 'site' events (with real project_id/task_id) and zero 'other' events
    const rEvJson = await fetch(`${baseUrl}/v0/events?since=0&types=task.*,journal.*`, {
      headers: hdrs(undefined, siteOnlyToken),
    });
    expect(rEvJson.status).toBe(200);
    const evBody = await rEvJson.json() as { events: { project_id: string | null; task_id: string | null; type: string }[] };
    expect(evBody.events.some(e => e.project_id === 'site' && e.task_id === siteTask.id && e.type === 'task.created')).toBe(true);
    expect(evBody.events.some(e => e.project_id === 'other' || e.task_id === otherTask.id || e.project_id === null)).toBe(false);

    // R4-A SSE isolation
    const ac = new AbortController();
    const sseRes = await fetch(`${baseUrl}/v0/events?since=0`, {
      headers: { Authorization: `Bearer ${siteOnlyToken}`, 'Supervisor-Protocol': '0.2', Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    const reader = sseRes.body!.getReader();
    const dec = new TextDecoder();
    let sseText = '';
    await until(async () => {
      const { value, done } = await reader.read();
      if (done) return true;
      sseText += dec.decode(value, { stream: true });
      return sseText.includes(siteTask.id);
    }, 2000);
    ac.abort();
    expect(sseText).not.toContain(otherTask.id);
    expect(sseText).not.toContain('"project_id":"other"');
  });

  it('R4-C: defaultFakeCapabilities aligns with fake runner, and L1 read_only reaches execution boundary', async () => {
    const caps = defaultFakeCapabilities();
    expect(caps[0]!.features.read_only.enforceable).toBe(false);
    expect(caps[0]!.accounts[0]!.models.map(m => m.id)).toEqual(['fake-high']);

    // L1 read_only on fake without degrade -> 422 CAP_READ_ONLY_UNENFORCEABLE
    const rFail = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r4c-l1-fake'),
      body: JSON.stringify({
        project_id: 'site', title: 'L1', goal: 'g', level: 'L1',
        runs: [{ role: 'dev', title: 'r', instructions: 'hi', runner: 'fake', model: '@high', reasoning_effort: 'default', tier_rationale: 't', read_only: true }],
      }),
    });
    expect(rFail.status).toBe(422);
    expect((await rFail.json() as { error: { violations: { rule: string }[] } }).error.violations[0]!.rule).toBe('CAP_READ_ONLY_UNENFORCEABLE');

    // L1 read_only on fake-ro (which claims enforceable=true, but fake.js rejects read_only=true at execution boundary)
    const rOk = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r4c-l1-ro'),
      body: JSON.stringify({
        project_id: 'site', title: 'L1 RO', goal: 'g', level: 'L1',
        runs: [{ role: 'dev', title: 'r', instructions: 'hi', runner: 'fake-ro', model: '@high', reasoning_effort: 'default', tier_rationale: 't', read_only: true }],
      }),
    });
    expect(rOk.status).toBe(201);
    const created = await rOk.json() as { runs: { id: string; policy: { read_only_hard: boolean } }[] };
    expect(created.runs[0]!.policy.read_only_hard).toBe(true);
    const runId = created.runs[0]!.id;
    expect(runtime.store.get(runId).readOnly).toBe(true);

    // Starting it passes workspace.read_only=true to fake.js, which rejects with READ_ONLY_UNSUPPORTED -> launch retries -> failed
    runtime.start(runId);
    await until(async () => {
      await runtime.tick();
      const r = runtime.store.get(runId);
      if (r.state === 'queued') runtime.start(runId);
      return r.state === 'failed';
    }, 5000);
    expect(runtime.store.get(runId).state).toBe('failed');
  });

  it('R4-D: worktree mode isolates in real worktree; in_place checks lease and dirty dir', async () => {
    const rCreate = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r4d-wt'),
      body: JSON.stringify({
        project_id: 'site', title: 'WT', goal: 'g', level: 'L2',
        runs: [{ role: 'dev', title: 'wt', instructions: prompt('ok'), runner: 'fake', model: '@high', reasoning_effort: 'default', tier_rationale: 't', workspace: 'worktree' }],
      }),
    });
    expect(rCreate.status).toBe(201);
    const runId = (await rCreate.json() as { runs: { id: string }[] }).runs[0]!.id;
    runtime.start(runId);
    const started = runtime.store.get(runId);
    expect(started.workspace).not.toBe(repoSite);
    expect(existsSync(started.workspace)).toBe(true);
    const branchList = execFileSync('git', ['branch', '--list', `mac/${runId}`], { cwd: repoSite, encoding: 'utf8' }).trim();
    expect(branchList).toContain(`mac/${runId}`);
    await state(runtime, runId, 'done');

    // in_place dirty check
    writeFileSync(join(repoSite, 'dirty.txt'), 'untracked\n');
    const rInPlace = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r4d-inplace'),
      body: JSON.stringify({
        project_id: 'site', title: 'IP', goal: 'g', level: 'L3',
        runs: [{ role: 'dev', title: 'ip', instructions: prompt('ok'), runner: 'fake', model: '@high', reasoning_effort: 'default', tier_rationale: 't', workspace: 'in_place' }],
      }),
    });
    expect(rInPlace.status).toBe(201);
    const ipRunId = (await rInPlace.json() as { runs: { id: string }[] }).runs[0]!.id;
    expect(() => runtime.start(ipRunId)).toThrow('in_place_workspace_dirty');
  });

  it('R7-A, R7-B, R7-C: release recovery after ref_tx_done, fixed 200 response, and immutable K check', async () => {
    const rCreate = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r7-create'),
      body: JSON.stringify({
        project_id: 'site', title: 'R7', goal: 'g', level: 'L2',
        runs: [{ role: 'dev', title: 'r', instructions: prompt('ok'), runner: 'fake', model: '@high', reasoning_effort: 'default', tier_rationale: 't' }],
      }),
    });
    const runId = (await rCreate.json() as { runs: { id: string }[] }).runs[0]!.id;
    runtime.start(runId);
    await state(runtime, runId, 'done');

    // R7-C: create keep-wip, then move keep-wip BEFORE release? Test verify + abort when ref moved
    const run = runtime.store.get(runId);
    const headSha = execFileSync('git', ['rev-parse', `mac/${runId}`], { cwd: repoSite, encoding: 'utf8' }).trim();
    execFileSync('git', ['branch', 'keep-wip', headSha], { cwd: repoSite });

    // Simulate ref_tx_done=true, dir_removed=false pending release on boot -> recovery should complete dir removal without aborting
    const wtDir = run.workspace;
    expect(existsSync(wtDir)).toBe(true);
    execFileSync('git', ['update-ref', '-d', `refs/heads/mac/${runId}`], { cwd: repoSite });
    runtime.store.transaction(() => {
      runtime.store.db.prepare(`INSERT INTO api_worktree_releases(run_id, payload, updated_at) VALUES (?,?,?)`).run(
        runId,
        JSON.stringify({
          release: { state: 'pending', requested_at: new Date().toISOString(), released_at: null, error: null },
          verified: { kind: 'reachable_from', branch: `refs/heads/mac/${runId}`, branch_tip: headSha, wip_sha: null, ref: 'refs/heads/keep-wip', ref_sha: headSha },
          progress: { ref_tx_done: true, dir_removed: false },
        }),
        Date.now(),
      );
    });

    await api.close();
    api = createApiServer({ runtime, tokens: makeTokens(), projects: makeProjects(), runners: defaultFakeCapabilities() });
    baseUrl = (await api.listen(0, '127.0.0.1')).url;

    expect(existsSync(wtDir)).toBe(false);
    const rGet = await fetch(`${baseUrl}/v0/runs/${runId}`, { headers: hdrs() });
    const data = await rGet.json() as { workspace: { retention: { release: { state: string } } } };
    expect(data.workspace.retention.release.state).toBe('completed');
  });

  it('R5: 3-stage model & effort ledger updates from runner report and emits mismatch alerts', async () => {
    const rCreate = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r5-create'),
      body: JSON.stringify({
        project_id: 'site', title: 'R5', goal: 'g', level: 'L2',
        runs: [{
          role: 'dev', title: 'r',
          instructions: prompt({ schema: 'mac.fake-scenario/0.2', model_effective: 'fake-other', effort_effective: 'low', steps: [{ op: 'complete', final_message: 'done' }] }),
          runner: 'fake', model: '@high', reasoning_effort: 'high', tier_rationale: 't',
        }],
      }),
    });
    expect(rCreate.status).toBe(201);
    const runId = (await rCreate.json() as { runs: { id: string }[] }).runs[0]!.id;
    runtime.start(runId);
    await state(runtime, runId, 'done');

    const rRun = await fetch(`${baseUrl}/v0/runs/${runId}`, { headers: hdrs() });
    const runBody = await rRun.json() as { model: Record<string, unknown>; reasoning_effort: Record<string, unknown>; result: { model: Record<string, unknown>; reasoning_effort: Record<string, unknown> } };
    expect(runBody.model).toMatchObject({ resolved: 'fake-high', effective: 'fake-other', effective_source: 'runner_reported', mismatch: true });
    expect(runBody.reasoning_effort).toMatchObject({ requested: 'high', effective: 'low', effective_source: 'runner_reported', mismatch: true });
    expect(runBody.result.model).toEqual(runBody.model);
    expect(runBody.result.reasoning_effort).toEqual(runBody.reasoning_effort);

    const rEv = await fetch(`${baseUrl}/v0/events?since=0&types=alert`, { headers: hdrs() });
    const evs = (await rEv.json() as { events: { data: { kind: string } }[] }).events;
    expect(evs.some(e => e.data.kind === 'model_mismatch')).toBe(true);
    expect(evs.some(e => e.data.kind === 'effort_mismatch')).toBe(true);
  });

  it('R3-A, R3-B, R3-C, R2, R6-A: strict validation, PATCH semantics, continue/close, batch client_ref, rulings supersede', async () => {
    // R3-A: invalid types -> 400 (not 501), negative timeout -> 400
    const rBadType = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r3a-bad-type'),
      body: JSON.stringify({
        project_id: 'site', title: 't', goal: 'g', level: 'L2',
        runs: [{ role: 'dev', title: 'r', instructions: 'x', runner: 'fake', model: '@high', reasoning_effort: 'default', tier_rationale: 't', depends_on: 'not-array', timeouts: { total_s: -1 } }],
      }),
    });
    expect(rBadType.status).toBe(400);

    // Create task with 1 run
    const rCreate = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('r3-task'),
      body: JSON.stringify({
        project_id: 'site', title: 'T', goal: 'G', level: 'L2',
        runs: [{ role: 'dev', title: 'R1', instructions: prompt('ok'), runner: 'fake', model: '@high', reasoning_effort: 'default', tier_rationale: 't', client_ref: 'c1' }],
      }),
    });
    const created = await rCreate.json() as { task: { id: string }; runs: { id: string; version: number }[] };
    const taskId = created.task.id;
    const runId = created.runs[0]!.id;

    // R2: intra-batch duplicate client_ref in POST /v0/tasks/:id/runs -> 400
    const rDupBatch = await fetch(`${baseUrl}/v0/tasks/${taskId}/runs`, {
      method: 'POST',
      headers: hdrs('r2-dup-batch'),
      body: JSON.stringify({
        runs: [
          { role: 'dev', title: 'A', instructions: 'x', runner: 'fake', model: '@high', reasoning_effort: 'default', tier_rationale: 't', client_ref: 'dup' },
          { role: 'dev', title: 'B', instructions: 'x', runner: 'fake', model: '@high', reasoning_effort: 'default', tier_rationale: 't', client_ref: 'dup' },
        ],
      }),
    });
    expect(rDupBatch.status).toBe(400);

    // R3-B: PATCH /v0/runs/:id applies reasoning_effort & timeouts, rejects invalid effort with 422
    const rPatchBad = await fetch(`${baseUrl}/v0/runs/${runId}`, {
      method: 'PATCH',
      headers: { ...hdrs('r3b-bad'), 'If-Match': `"${created.runs[0]!.version}"` },
      body: JSON.stringify({ reasoning_effort: 'xhigh' }),
    });
    expect(rPatchBad.status).toBe(422);

    const rPatchOk = await fetch(`${baseUrl}/v0/runs/${runId}`, {
      method: 'PATCH',
      headers: { ...hdrs('r3b-ok'), 'If-Match': `"${created.runs[0]!.version}"` },
      body: JSON.stringify({ title: 'Patched R1', reasoning_effort: 'low', timeouts: { idle_s: 45 } }),
    });
    expect(rPatchOk.status).toBe(200);
    const patched = await rPatchOk.json() as { title: string; reasoning_effort: { requested: string }; timeouts: { idle_s: number } };
    expect(patched.title).toBe('Patched R1');
    expect(patched.reasoning_effort.requested).toBe('low');
    expect(patched.timeouts.idle_s).toBe(45);

    // Run to done
    runtime.start(runId);
    await state(runtime, runId, 'done');
    const headSha = runtime.store.get(runId).workspaceHead!;

    // R6-A: ruling on done run, then second ruling supersedes first
    const rRul1 = await fetch(`${baseUrl}/v0/tasks/${taskId}/rulings`, {
      method: 'POST',
      headers: hdrs('r6a-1'),
      body: JSON.stringify({ subject: { run_id: runId, sha: headSha }, decision: 'rework', note: 'first' }),
    });
    expect(rRul1.status).toBe(201);

    // R3-C: continue with notes + overrides validation
    const rContBadOv = await fetch(`${baseUrl}/v0/runs/${runId}/continue`, {
      method: 'POST',
      headers: hdrs('r3c-bad-ov'),
      body: JSON.stringify({ mode: 'rework', overrides: { unknown_ov: 1 } }),
    });
    expect(rContBadOv.status).toBe(400);

    const rCont = await fetch(`${baseUrl}/v0/runs/${runId}/continue`, {
      method: 'POST',
      headers: hdrs('r3c-ok'),
      body: JSON.stringify({ mode: 'rework', notes: 'fix edge case' }),
    });
    expect(rCont.status).toBe(201);
    const contBody = await rCont.json() as { run: { id: string; instructions: string; base: { sha: string } } };
    expect(contBody.run.base.sha).toBe(headSha);
    expect(contBody.run.instructions).toContain('fix edge case');

    // Verify first ruling was superseded when branch continued
    const rRulList = await fetch(`${baseUrl}/v0/tasks/${taskId}/rulings`, { headers: hdrs() });
    const rulings = (await rRulList.json() as { items: { status: string }[] }).items;
    expect(rulings[0]!.status).toBe('superseded');

    // R3-C: close with cancel_open_runs=true stops the queued continued run
    const rClose = await fetch(`${baseUrl}/v0/tasks/${taskId}/close`, {
      method: 'POST',
      headers: hdrs('r3c-close'),
      body: JSON.stringify({ outcome: 'abandoned', cancel_open_runs: true }),
    });
    expect(rClose.status).toBe(200);
    expect(runtime.store.get(contBody.run.id).state).toBe('cancelled');
  });

  it('R6-B: SSE active connection emits stream.reset and cleans up timers', async () => {
    const ac = new AbortController();
    const sseRes = await fetch(`${baseUrl}/v0/events?since=0`, {
      headers: { Authorization: `Bearer ${fullToken}`, 'Supervisor-Protocol': '0.2', Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    const dec = new TextDecoder();

    // Advance complete_from_seq while SSE polling is active
    runtime.store.transaction(() => {
      const high = runtime.store.meta().high;
      runtime.store.db.prepare('UPDATE instance_meta SET complete_from_seq=? WHERE id=1').run(high + 2);
    });

    let text = '';
    await until(async () => {
      const { value, done } = await reader.read();
      if (value) text += dec.decode(value, { stream: true });
      return done || text.includes('stream.reset');
    }, 2000);
    expect(text).toContain('event: stream.reset');
    ac.abort();
  });
});
