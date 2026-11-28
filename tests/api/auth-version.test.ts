import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer, defaultFakeCapabilities, type ApiServer, type ProjectConfig, type TokenConfig } from '../../dist/api/index.js';
import { Runtime } from '../../dist/core/runtime.js';
import { markerPreserver } from '../helpers/runtime.js';

describe('API Auth, Version Negotiation, and L4 Rejection', () => {
  let root: string;
  let runtime: Runtime;
  let api: ApiServer;
  let baseUrl: string;

  const fullToken = 'mact_full_secret_token_001';
  const readOnlyToken = 'mact_readonly_token_002';
  const expiredToken = 'mact_expired_token_003';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mac-api-auth-'));
    const repoPath = join(root, 'repo-site');
    mkdirSync(repoPath, { recursive: true });
    runtime = new Runtime({ root: join(root, 'rt'), preserve: markerPreserver });
    const tokens: TokenConfig[] = [
      { token: fullToken, token_id: 'tok_full', principal: 'xiaoba', scopes: ['read', 'submit', 'control', 'decide'], projects: ['site'] },
      { token: readOnlyToken, token_id: 'tok_ro', principal: 'reader', scopes: ['read'], projects: ['site'] },
      { token: expiredToken, token_id: 'tok_exp', principal: 'old', scopes: ['read'], projects: ['*'], expires_at: '2020-01-01T00:00:00.000Z' },
    ];
    const projects: ProjectConfig[] = [
      {
        id: 'site',
        name: 'Site',
        default_branch: 'main',
        workspace_path: repoPath,
        max_level: 'L3',
        forbidden: [],
        limits: { concurrency: 2 },
        defaults: { timeouts: { total_s: 600, idle_s: 120 }, reclaim_after_s: 3600 },
      },
      {
        id: 'secret-proj',
        name: 'Secret',
        default_branch: 'main',
        workspace_path: repoPath,
        max_level: 'L2',
        forbidden: [],
        limits: { concurrency: 1 },
        defaults: { timeouts: { total_s: 600, idle_s: 120 }, reclaim_after_s: 3600 },
      },
    ];
    api = createApiServer({
      instanceId: 'test-inst',
      runtime,
      tokens,
      projects,
      runners: defaultFakeCapabilities(),
    });
    const addr = await api.listen(0, '127.0.0.1');
    baseUrl = addr.url;
  });

  afterEach(async () => {
    await api.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('S-01: discovery endpoint is accessible without auth', async () => {
    const res = await fetch(`${baseUrl}/.well-known/multi-agent-core`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.service).toBe('multi-agent-core');
    expect(body.instance_id).toBe('test-inst');
    expect((body.protocols as Record<string, unknown>).supervisor).toEqual({ versions: ['0.2'], base_path: '/v0' });
  });

  it('S-04: rejects missing, invalid, and expired tokens with 401; insufficient scope with 403', async () => {
    const r1 = await fetch(`${baseUrl}/v0/whoami`, { headers: { 'Supervisor-Protocol': '0.2' } });
    expect(r1.status).toBe(401);
    expect((await r1.json() as { error: { code: string } }).error.code).toBe('unauthenticated');

    const r2 = await fetch(`${baseUrl}/v0/whoami`, { headers: { Authorization: 'Bearer wrong', 'Supervisor-Protocol': '0.2' } });
    expect(r2.status).toBe(401);

    const r3 = await fetch(`${baseUrl}/v0/whoami`, { headers: { Authorization: `Bearer ${expiredToken}`, 'Supervisor-Protocol': '0.2' } });
    expect(r3.status).toBe(401);

    const r4 = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readOnlyToken}`, 'Supervisor-Protocol': '0.2', 'Idempotency-Key': 'k1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'site', title: 't', goal: 'g', level: 'L2' }),
    });
    expect(r4.status).toBe(403);
    const b4 = await r4.json() as { error: { code: string; details: { required: string } } };
    expect(b4.error.code).toBe('forbidden_scope');
    expect(b4.error.details.required).toBe('submit');
  });

  it('S-05: unauthorized project returns 403 on write and 404 on GET', async () => {
    const rPost = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'Supervisor-Protocol': '0.2', 'Idempotency-Key': 'k-unauth', 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'secret-proj', title: 't', goal: 'g', level: 'L2' }),
    });
    expect(rPost.status).toBe(403);
    expect((await rPost.json() as { error: { code: string } }).error.code).toBe('project_not_authorized');

    const rGet = await fetch(`${baseUrl}/v0/projects/secret-proj`, {
      headers: { Authorization: `Bearer ${fullToken}`, 'Supervisor-Protocol': '0.2' },
    });
    expect(rGet.status).toBe(404);
  });

  it('S-02/S-03: version negotiation on GET vs POST', async () => {
    const rGetNoHdr = await fetch(`${baseUrl}/v0/whoami`, { headers: { Authorization: `Bearer ${fullToken}` } });
    expect(rGetNoHdr.status).toBe(200);
    expect(rGetNoHdr.headers.get('supervisor-protocol')).toBe('0.2');
    expect(rGetNoHdr.headers.get('warning')).toContain('missing Supervisor-Protocol');

    const rGetHigher = await fetch(`${baseUrl}/v0/whoami`, { headers: { Authorization: `Bearer ${fullToken}`, 'Supervisor-Protocol': '0.5' } });
    expect(rGetHigher.status).toBe(200);
    expect(rGetHigher.headers.get('supervisor-protocol')).toBe('0.2');

    const rGetOld = await fetch(`${baseUrl}/v0/whoami`, { headers: { Authorization: `Bearer ${fullToken}`, 'Supervisor-Protocol': '0.1' } });
    expect(rGetOld.status).toBe(400);
    expect((await rGetOld.json() as { error: { code: string } }).error.code).toBe('protocol_version_unsupported');

    const rPostNoHdr = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'Idempotency-Key': 'k-no-ver', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(rPostNoHdr.status).toBe(400);
    const bNoHdr = await rPostNoHdr.json() as { error: { code: string; details: { reason: string } } };
    expect(bNoHdr.error.code).toBe('protocol_version_unsupported');
    expect(bNoHdr.error.details.reason).toBe('missing');

    const rPostHigher = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'Supervisor-Protocol': '0.3', 'Idempotency-Key': 'k-hi-ver', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(rPostHigher.status).toBe(400);
  });

  it('S-36: rejects L4 level and L4 action endpoints', async () => {
    const rLevel = await fetch(`${baseUrl}/v0/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'Supervisor-Protocol': '0.2', 'Idempotency-Key': 'k-l4', 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'site', title: 'L4 task', goal: 'push', level: 'L4' }),
    });
    expect(rLevel.status).toBe(422);
    const bLevel = await rLevel.json() as { error: { code: string; violations: { rule: string }[] } };
    expect(bLevel.error.code).toBe('validation_failed');
    expect(bLevel.error.violations.some(v => v.rule === 'LEVEL_L4_FORBIDDEN')).toBe(true);

    for (const path of ['/v0/runs/run_1/merge', '/v0/runs/run_1/push', '/v0/tasks/task_1/deploy', '/v0/l4/secrets']) {
      const rAct = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fullToken}`, 'Supervisor-Protocol': '0.2', 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(rAct.status).toBe(403);
    }
  });
});
