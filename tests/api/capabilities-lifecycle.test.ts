import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer, defaultFakeCapabilities, type ApiServer } from '../../dist/api/index.js';
import { Runtime } from '../../dist/core/runtime.js';
import { markerPreserver, prompt, state } from '../helpers/runtime.js';

describe('API Capabilities, 3-Stage Model/Effort, and Run/Task Lifecycle', () => {
  let root: string;
  let runtime: Runtime;
  let api: ApiServer;
  let baseUrl: string;
  const token = 'mact_test_token_cap';

  const hdrs = (key?: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    'Supervisor-Protocol': '0.2',
    'Content-Type': 'application/json',
    ...(key ? { 'Idempotency-Key': key } : {}),
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mac-api-cap-'));
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'README.md'), 'init\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
    runtime = new Runtime({ root: join(root, 'rt'), preserve: markerPreserver, timing: { exitMs: 120, killMs: 70, graceMs: 70 } });
    const caps = defaultFakeCapabilities();
    // Add an advisory-only runner without enforceable read_only
    const advisoryRunner = structuredClone(caps[0]!);
    advisoryRunner.id = 'advisory-fake';
    advisoryRunner.features.read_only.enforceable = false;
    advisoryRunner.accounts[0]!.id = 'adv-acc';

    api = createApiServer({
      runtime,
      tokens: [{ token, token_id: 't1', principal: 'xiaoba', scopes: ['read', 'submit', 'control', 'decide'], projects: ['site'] }],
      projects: [{
        id: 'site',
        name: 'Site',
        default_branch: 'main',
        workspace_path: repoPath,
        max_level: 'L3',
        forbidden: [],
        limits: { concurrency: 4 },
        defaults: { timeouts: { total_s: 600, idle_s: 120 }, reclaim_after_s: 3600 },
      }],
      runners: [...caps, advisoryRunner],
      unadmitted: [{ runner: 'unadmitted-runner', account: null, reason: 'conformance_report_missing' }],
    });
    baseUrl = (await api.listen(0, '127.0.0.1')).url;
  });

  afterEach(async () => {
    await api.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('S-06/S-07/S-08/S-09/S-24: capabilities ETag, unadmitted, read_only degrade, and no silent effort downgrade', async () => {
    const rCap1 = await fetch(`${baseUrl}/v0/capabilities`, { headers: hdrs() });
    expect(rCap1.status).toBe(200);
    const etag = rCap1.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const capBody = await rCap1.json() as { runners: unknown[]; unadmitted: { runner: string }[] };
    expect(capBody.unadmitted[0]!.runner).toBe('unadmitted-runner');

    const rCap304 = await fetch(`${baseUrl}/v0/capabilities`, { headers: { ...hdrs(), 'If-None-Match': etag } });
    expect(rCap304.status).toBe(304);

    // Unsupported effort must fail with EFFORT_UNSUPPORTED (no silent downgrade)
    const rBadEffort = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('k-bad-effort'),
      body: JSON.stringify({
        project_id: 'site',
        title: 'Bad effort',
        goal: 'g',
        level: 'L2',
        runs: [{
          role: 'dev', title: 'r', instructions: 'x', runner: 'fake',
          model: '@high', reasoning_effort: 'xhigh', tier_rationale: 'test',
        }],
      }),
    });
    expect(rBadEffort.status).toBe(422);
    expect((await rBadEffort.json() as { error: { violations: { rule: string }[] } }).error.violations[0]!.rule).toBe('EFFORT_UNSUPPORTED');

    // read_only on advisory-fake without degrade -> CAP_READ_ONLY_UNENFORCEABLE
    const rNoDegrade = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('k-no-deg'),
      body: JSON.stringify({
        project_id: 'site',
        title: 'RO',
        goal: 'g',
        level: 'L2',
        runs: [{
          role: 'dev', title: 'r', instructions: 'x', runner: 'advisory-fake',
          model: '@high', reasoning_effort: 'high', tier_rationale: 'test', read_only: true,
        }],
      }),
    });
    expect(rNoDegrade.status).toBe(422);
    expect((await rNoDegrade.json() as { error: { violations: { rule: string }[] } }).error.violations[0]!.rule).toBe('CAP_READ_ONLY_UNENFORCEABLE');

    // L1 forbids read_only degrade -> DEGRADE_FORBIDDEN_BY_POLICY
    const rL1Degrade = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('k-l1-deg'),
      body: JSON.stringify({
        project_id: 'site',
        title: 'RO L1',
        goal: 'g',
        level: 'L1',
        runs: [{
          role: 'dev', title: 'r', instructions: 'x', runner: 'advisory-fake',
          model: '@high', reasoning_effort: 'high', tier_rationale: 'test', read_only: true,
          degrade: [{ capability: 'read_only', mode: 'advisory', reason: 'allow advisory' }],
        }],
      }),
    });
    expect(rL1Degrade.status).toBe(422);
    expect((await rL1Degrade.json() as { error: { violations: { rule: string }[] } }).error.violations[0]!.rule).toBe('DEGRADE_FORBIDDEN_BY_POLICY');

    // L2 with authorized degrade -> 201 and records degraded + 3-stage model/effort
    const rOkDegrade = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('k-ok-deg'),
      body: JSON.stringify({
        project_id: 'site',
        title: 'RO L2',
        goal: 'g',
        level: 'L2',
        runs: [{
          role: 'dev', title: 'r', instructions: 'x', runner: 'advisory-fake',
          model: '@high', reasoning_effort: 'high', tier_rationale: 'test', read_only: true,
          degrade: [{ capability: 'read_only', mode: 'advisory', reason: 'allow advisory' }],
        }],
      }),
    });
    expect(rOkDegrade.status).toBe(201);
    const bOk = await rOkDegrade.json() as { runs: { degraded: unknown[]; model: Record<string, unknown>; reasoning_effort: Record<string, unknown> }[] };
    expect(bOk.runs[0]!.degraded).toHaveLength(1);
    expect(bOk.runs[0]!.model).toMatchObject({ requested: '@high', resolved: null, effective: null, effective_source: 'unknown' });
    expect(bOk.runs[0]!.reasoning_effort).toMatchObject({ requested: 'high', resolved_native: null, effective: null, effective_source: 'unknown' });
  });

  it('end-to-end interactive run: create -> start -> message -> complete -> ruling -> close', async () => {
    const rCreate = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('k-e2e-create'),
      body: JSON.stringify({
        project_id: 'site',
        title: 'Interactive Task',
        goal: 'Test interactive',
        level: 'L2',
        runs: [{
          role: 'dev',
          title: 'Interactive Run',
          instructions: prompt('interactive:2'),
          runner: 'fake',
          model: '@high',
          reasoning_effort: 'default',
          tier_rationale: 'e2e test',
          interaction: 'interactive',
        }],
      }),
    });
    expect(rCreate.status).toBe(201);
    const created = await rCreate.json() as { task: { id: string }; runs: { id: string }[] };
    const taskId = created.task.id;
    const runId = created.runs[0]!.id;

    runtime.start(runId);
    await state(runtime, runId, 'waiting');

    const rMsg = await fetch(`${baseUrl}/v0/runs/${runId}/messages`, {
      method: 'POST',
      headers: hdrs('k-e2e-msg'),
      body: JSON.stringify({ text: 'proceed', kind: 'answer' }),
    });
    expect(rMsg.status).toBe(202);

    runtime.start(runId);
    await state(runtime, runId, 'waiting');

    const rComplete = await fetch(`${baseUrl}/v0/runs/${runId}/complete`, {
      method: 'POST',
      headers: hdrs('k-e2e-complete'),
      body: JSON.stringify({ note: 'finish now' }),
    });
    expect(rComplete.status).toBe(202);

    await state(runtime, runId, 'done');
    const doneRun = runtime.store.get(runId);
    const headSha = doneRun.preservation.sha ?? doneRun.workspaceHead!;
    expect(headSha).toMatch(/^[0-9a-f]{40}$/);

    // Zero-SHA ruling must be rejected (R8)
    const rBadRuling = await fetch(`${baseUrl}/v0/tasks/${taskId}/rulings`, {
      method: 'POST',
      headers: hdrs('k-e2e-ruling-bad'),
      body: JSON.stringify({
        subject: { run_id: runId, sha: '0'.repeat(40) },
        decision: 'accept',
        note: 'bad sha',
      }),
    });
    expect(rBadRuling.status).toBe(422);

    const rRuling = await fetch(`${baseUrl}/v0/tasks/${taskId}/rulings`, {
      method: 'POST',
      headers: hdrs('k-e2e-ruling'),
      body: JSON.stringify({
        subject: { run_id: runId, sha: headSha },
        decision: 'accept',
        note: 'looks good',
      }),
    });
    expect(rRuling.status).toBe(201);

    const rClose = await fetch(`${baseUrl}/v0/tasks/${taskId}/close`, {
      method: 'POST',
      headers: hdrs('k-e2e-close'),
      body: JSON.stringify({ outcome: 'superseded', note: 'done' }),
    });
    expect(rClose.status).toBe(200);
    expect((await rClose.json() as { state: string }).state).toBe('closed');
  });
});
