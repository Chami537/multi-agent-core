import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer, defaultFakeCapabilities, type ApiServer } from '../../dist/api/index.js';
import { move } from '../../dist/core/lifecycle.js';
import { Runtime } from '../../dist/core/runtime.js';
import { markerPreserver, until } from '../helpers/runtime.js';

describe('API SSE Events Catchup/Reset and Worktree Release', () => {
  let root: string;
  let repoPath: string;
  let runtime: Runtime;
  let api: ApiServer;
  let baseUrl: string;
  const token = 'mact_test_token_ev';

  const hdrs = (key?: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    'Supervisor-Protocol': '0.2',
    'Content-Type': 'application/json',
    ...(key ? { 'Idempotency-Key': key } : {}),
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mac-api-ev-'));
    repoPath = join(root, 'repo');
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'README.md'), 'init\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });

    runtime = new Runtime({ root: join(root, 'rt'), preserve: markerPreserver });
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
        limits: { concurrency: 2 },
        defaults: { timeouts: { total_s: 600, idle_s: 120 }, reclaim_after_s: 3600 },
      }],
      runners: defaultFakeCapabilities(),
      ssePollMs: 15,
    });
    baseUrl = (await api.listen(0, '127.0.0.1')).url;
  });

  afterEach(async () => {
    await api.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('S-29/S-31: SSE catchup via Last-Event-ID and stream.reset when since < complete_from_seq', async () => {
    // Generate some events via task creation
    const rCreate = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('k-ev-1'),
      body: JSON.stringify({
        project_id: 'site',
        title: 'SSE Task',
        goal: 'Test SSE',
        level: 'L2',
        runs: [{ role: 'dev', title: 'R1', instructions: 'hi', runner: 'fake', model: '@high', reasoning_effort: 'default', tier_rationale: 't' }],
      }),
    });
    expect(rCreate.status).toBe(201);

    // JSON catchup page
    const rPage = await fetch(`${baseUrl}/v0/events?since=0`, { headers: hdrs() });
    expect(rPage.status).toBe(200);
    const page = await rPage.json() as { events: { seq: number; type: string }[]; reset: boolean; complete_from_seq: number };
    expect(page.reset).toBe(false);
    expect(page.events.length).toBeGreaterThanOrEqual(3);

    // SSE catchup from seq 1
    const ac = new AbortController();
    const sseRes = await fetch(`${baseUrl}/v0/events`, {
      headers: { Authorization: `Bearer ${token}`, 'Supervisor-Protocol': '0.2', Accept: 'text/event-stream', 'Last-Event-ID': '1' },
      signal: ac.signal,
    });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    const dec = new TextDecoder();
    let collected = '';
    await until(async () => {
      const { value, done } = await reader.read();
      if (done) return true;
      collected += dec.decode(value, { stream: true });
      return collected.includes('run.state_changed');
    }, 2000);
    ac.abort();
    expect(collected).toContain('retry: 3000');
    expect(collected).toContain('id: 2');
    expect(collected).toContain('event: run.created');

    // Simulate retention prune advancing complete_from_seq
    const high = runtime.store.meta().high;
    runtime.store.transaction(() => {
      runtime.store.db.prepare('UPDATE instance_meta SET complete_from_seq=? WHERE id=1').run(high + 1);
    });

    // Requesting since=1 (< complete_from_seq - 1) must emit stream.reset without id: and close
    const resetRes = await fetch(`${baseUrl}/v0/events?since=1`, {
      headers: { Authorization: `Bearer ${token}`, 'Supervisor-Protocol': '0.2', Accept: 'text/event-stream' },
    });
    const resetText = await resetRes.text();
    expect(resetText).toContain('event: stream.reset');
    expect(resetText).not.toMatch(/^id:/m);
    expect(resetText).toContain(`"complete_from_seq":${high + 1}`);
  });

  it('S-35: release-worktree verifies reachable_from ref atomically and deletes run branch', async () => {
    const rCreate = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('k-wt-1'),
      body: JSON.stringify({
        project_id: 'site',
        title: 'Worktree Task',
        goal: 'Test worktree release',
        level: 'L2',
        runs: [{ role: 'dev', title: 'R1', instructions: 'hi', runner: 'fake', model: '@high', reasoning_effort: 'default', tier_rationale: 't' }],
      }),
    });
    const created = await rCreate.json() as { runs: { id: string }[] };
    const runId = created.runs[0]!.id;

    // Create run branch mac/<runId> with a commit, and advance keep-wip to include it
    execFileSync('git', ['checkout', '-b', `mac/${runId}`], { cwd: repoPath });
    writeFileSync(join(repoPath, 'work.txt'), 'work\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'wip work'], { cwd: repoPath });
    execFileSync('git', ['branch', 'keep-wip'], { cwd: repoPath });
    execFileSync('git', ['checkout', 'main'], { cwd: repoPath });

    // Move run to cancelled so it is terminal
    runtime.store.transaction(() => {
      const r = runtime.store.get(runId);
      move(r, 'cancelled', 'supervisor_cancel', 'T19', Date.now());
      runtime.store.put(r);
    });

    // Reject ref inside mac/* namespace
    const rBadRef = await fetch(`${baseUrl}/v0/runs/${runId}/release-worktree`, {
      method: 'POST',
      headers: hdrs('k-wt-bad'),
      body: JSON.stringify({ preservation: { kind: 'reachable_from', ref: `refs/heads/mac/${runId}` } }),
    });
    expect(rBadRef.status).toBe(422);
    expect((await rBadRef.json() as { error: { code: string; details: { reason: string } } }).error.details.reason).toBe('ref_in_deletion_namespace');

    // Valid reachable_from release
    const rOk = await fetch(`${baseUrl}/v0/runs/${runId}/release-worktree`, {
      method: 'POST',
      headers: hdrs('k-wt-ok'),
      body: JSON.stringify({ preservation: { kind: 'reachable_from', ref: 'refs/heads/keep-wip' }, note: 'saved' }),
    });
    expect(rOk.status).toBe(200);
    const bOk = await rOk.json() as { release: { state: string } };
    expect(bOk.release.state).toBe('pending');

    // Verify run branch was deleted and release state became completed
    const rGet = await fetch(`${baseUrl}/v0/runs/${runId}`, { headers: hdrs() });
    const runData = await rGet.json() as { workspace: { retention: { release: { state: string } } } };
    expect(runData.workspace.retention.release.state).toBe('completed');

    const branches = execFileSync('git', ['branch', '--list', `mac/${runId}`], { cwd: repoPath, encoding: 'utf8' });
    expect(branches.trim()).toBe('');
  });
});
