import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer, defaultFakeCapabilities, type ApiServer } from '../../dist/api/index.js';
import { Runtime } from '../../dist/core/runtime.js';
import { markerPreserver } from '../helpers/runtime.js';

describe('API Idempotency, Strict Validation, and Phase 1 Boundaries', () => {
  let root: string;
  let runtime: Runtime;
  let api: ApiServer;
  let baseUrl: string;
  const token = 'mact_test_token_idem';

  const hdrs = (key?: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    'Supervisor-Protocol': '0.2',
    'Content-Type': 'application/json',
    ...(key ? { 'Idempotency-Key': key } : {}),
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mac-api-idem-'));
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath, { recursive: true });
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
    });
    baseUrl = (await api.listen(0, '127.0.0.1')).url;
  });

  afterEach(async () => {
    await api.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('S-03: rejects unknown fields on write requests with 400 and details.unknown_fields', async () => {
    const res = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('key-unknown-1'),
      body: JSON.stringify({
        project_id: 'site',
        title: 't',
        goal: 'g',
        level: 'L2',
        typo_field: 123,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; details: { unknown_fields: string[] } } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details.unknown_fields).toContain('typo_field');
  });

  it('§17.4: rejects out-of-phase endpoints and fields with 501 and writes NO idempotency record', async () => {
    const rEndpoint = await fetch(`${baseUrl}/v0/runs/batch-adjust`, {
      method: 'POST',
      headers: hdrs('key-501-ep'),
      body: JSON.stringify({}),
    });
    expect(rEndpoint.status).toBe(501);
    const bEp = await rEndpoint.json() as { error: { code: string; details: { operation: string; available_in: string } } };
    expect(bEp.error.code).toBe('not_implemented');
    expect(bEp.error.details.available_in).toBe('Phase 3');

    const rField = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('key-501-field'),
      body: JSON.stringify({
        project_id: 'site',
        title: 't',
        goal: 'g',
        level: 'L2',
        budget: { tokens: 1000 },
      }),
    });
    expect(rField.status).toBe(501);
    const bField = await rField.json() as { error: { code: string; details: { paths: string[]; available_in: string } } };
    expect(bField.error.code).toBe('not_implemented');
    expect(bField.error.details.paths).toContain('budget');
    expect(bField.error.details.available_in).toBe('Phase 3');

    // Verify no idempotency record was persisted for 501
    const count = runtime.store.db.prepare(`SELECT COUNT(*) AS c FROM api_idempotency WHERE idempotency_key IN ('key-501-ep','key-501-field')`).get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('S-12/S-13: Idempotency-Key replay, conflict, and client_ref deduplication', async () => {
    const payload = {
      project_id: 'site',
      title: 'Task A',
      goal: 'Goal A',
      level: 'L2',
      client_ref: 'cref-task-a',
      runs: [{
        role: 'dev',
        title: 'Run 1',
        instructions: 'do work',
        runner: 'fake',
        model: '@high',
        reasoning_effort: 'default',
        tier_rationale: 'testing',
        client_ref: 'cref-run-1',
      }],
    };

    const r1 = await fetch(`${baseUrl}/v0/tasks`, { method: 'POST', headers: hdrs('idem-create-1'), body: JSON.stringify(payload) });
    expect(r1.status).toBe(201);
    expect(r1.headers.get('idempotent-replayed')).toBeNull();
    const b1 = await r1.json() as { task: { id: string }; runs: { id: string }[] };

    // Replay same key + same body
    const r2 = await fetch(`${baseUrl}/v0/tasks`, { method: 'POST', headers: hdrs('idem-create-1'), body: JSON.stringify(payload) });
    expect(r2.status).toBe(201);
    expect(r2.headers.get('idempotent-replayed')).toBe('true');
    const b2 = await r2.json() as { task: { id: string } };
    expect(b2.task.id).toBe(b1.task.id);

    // Same key + different body -> 409 idempotency_conflict
    const rConflict = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('idem-create-1'),
      body: JSON.stringify({ ...payload, title: 'Changed' }),
    });
    expect(rConflict.status).toBe(409);
    expect((await rConflict.json() as { error: { code: string } }).error.code).toBe('idempotency_conflict');

    // Different key + same client_ref + same body -> 200 Client-Ref-Replayed: true
    const rCrefSame = await fetch(`${baseUrl}/v0/tasks`, { method: 'POST', headers: hdrs('idem-create-2'), body: JSON.stringify(payload) });
    expect(rCrefSame.status).toBe(200);
    expect(rCrefSame.headers.get('client-ref-replayed')).toBe('true');
    expect((await rCrefSame.json() as { task: { id: string } }).task.id).toBe(b1.task.id);

    // Different key + same client_ref + different body -> 409 duplicate_client_ref
    const rCrefDiff = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: hdrs('idem-create-3'),
      body: JSON.stringify({ ...payload, title: 'Different' }),
    });
    expect(rCrefDiff.status).toBe(409);
    const bCrefDiff = await rCrefDiff.json() as { error: { code: string; details: { existing_task_id: string } } };
    expect(bCrefDiff.error.code).toBe('duplicate_client_ref');
    expect(bCrefDiff.error.details.existing_task_id).toBe(b1.task.id);

    // Duplicate run client_ref in same task -> 409 duplicate_client_ref
    const rRunDup = await fetch(`${baseUrl}/v0/tasks/${b1.task.id}/runs`, {
      method: 'POST',
      headers: hdrs('idem-add-run-dup'),
      body: JSON.stringify({ runs: [payload.runs[0]] }),
    });
    expect(rRunDup.status).toBe(409);
    const bRunDup = await rRunDup.json() as { error: { code: string; details: { existing_run_id: string; same_body: boolean } } };
    expect(bRunDup.error.code).toBe('duplicate_client_ref');
    expect(bRunDup.error.details.existing_run_id).toBe(b1.runs[0]!.id);
    expect(bRunDup.error.details.same_body).toBe(true);
  });
});
