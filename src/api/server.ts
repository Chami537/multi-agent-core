import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { InvalidState, move } from '../core/lifecycle.js';
import { assertTransition, isTerminal } from '../core/state-machine.js';
import type { Role, Run, Timeouts } from '../core/types.js';
import { aggregateUsage } from '../core/usage.js';
import { stateEvent } from '../store/ingest.js';
import { TokenRegistry, type AuthPrincipal } from './auth.js';
import { buildCapabilitiesPayload } from './capabilities.js';
import { handleEventsEndpoint } from './events.js';
import {
  computeRequestFingerprint,
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  IdempotencyManager,
  shouldRecordStatus,
  validateIdempotencyKey,
  type IdempotencyScope,
} from './idempotency.js';
import {
  canonicalJson,
  negotiateVersion,
  normalizePath,
  sendError,
  sendJson,
  sha256Hex,
  ulid,
} from './protocol.js';
import { ensureApiSchema } from './schema.js';
import { allowedOpsForState, serializeRun, serializeRunResult, serializeTask } from './serialize.js';
import {
  SUPPORTED_VERSIONS,
  type JournalRecord,
  type Level,
  type ProjectConfig,
  type RulingRecord,
  type RunMetadata,
  type Scope,
  type ServerConfig,
  type TaskRecord,
  type Violation,
  type WarningItem,
} from './types.js';
import {
  checkRunSpecPhase1,
  checkTaskCreatePhase1,
  collectRunSpecUnknownFields,
  collectTaskCreateUnknownFields,
  findUnknownFields,
  validateRunSpec,
  validateTaskLevel,
} from './validation.js';
import {
  executeWorktreeRelease,
  getReleaseState,
  saveReleaseState,
  verifyWorktreePreservation,
} from './worktree.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readJsonBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  return new Promise(resolvePromise => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        resolvePromise({ ok: false, message: 'Request body too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolvePromise({ ok: true, body: {} });
        return;
      }
      try {
        resolvePromise({ ok: true, body: JSON.parse(raw) });
      } catch {
        resolvePromise({ ok: false, message: 'Malformed JSON body' });
      }
    });
    req.on('error', () => {
      if (!settled) {
        settled = true;
        resolvePromise({ ok: false, message: 'Error reading request body' });
      }
    });
  });
}

function queryToObject(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const keys = [...new Set(url.searchParams.keys())].sort();
  for (const k of keys) {
    const vals = url.searchParams.getAll(k);
    out[k] = vals.length === 1 ? vals[0]! : vals;
  }
  return out;
}

export interface ApiServer {
  readonly server: Server;
  listen(port?: number, host?: string): Promise<{ port: number; host: string; url: string }>;
  close(): Promise<void>;
}

export function createApiServer(config: ServerConfig): ApiServer {
  const { runtime } = config;
  const store = runtime.store;
  ensureApiSchema(store.db);

  const instanceId = config.instanceId ?? 'mac-instance';
  const implVersion = config.implVersion ?? '0.1.0';
  const runBranchPrefix = config.runBranchPrefix ?? 'mac';
  const tokens = new TokenRegistry(config.tokens);
  const projectMap = new Map<string, ProjectConfig>(config.projects.map(p => [p.id, p]));
  const bootId = store.meta().boot ?? `epoch-${runtime.epoch}`;
  const idempotency = new IdempotencyManager(
    store,
    bootId,
    config.idempotencyWindowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS,
  );

  const getTaskRow = (taskId: string): { payload: string; request_fingerprint: string | null } | undefined => {
    return store.db.prepare('SELECT payload, request_fingerprint FROM api_tasks WHERE id=?').get(taskId) as
      | { payload: string; request_fingerprint: string | null }
      | undefined;
  };

  const getRunMeta = (runId: string): RunMetadata | null => {
    const row = store.db.prepare('SELECT payload FROM api_runs WHERE id=?').get(runId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as RunMetadata) : null;
  };

  const buildRunFromSpec = (params: {
    runId: string;
    taskId: string;
    project: ProjectConfig;
    spec: Record<string, unknown>;
    principal: AuthPrincipal;
    now: number;
    continues?: { run_id: string; mode: string; sha: string | null } | null;
    lineage?: RunMetadata['lineage'];
  }): { run: Run; meta: RunMetadata; warnings: WarningItem[] } => {
    const { runId, taskId, project, spec, principal, now } = params;
    const taskRow = getTaskRow(taskId);
    const taskLevel = taskRow ? (JSON.parse(taskRow.payload) as TaskRecord).level : ('L2' as Level);
    const check = validateRunSpec({
      spec,
      pathPrefix: 'run',
      taskLevel,
      project,
      runners: config.runners,
    });
    const resolved = check.resolved!;
    const primary = resolved.candidates[0]!;
    const workspacePath = resolve(project.workspace_path);
    const runDir = join(runtime.root, 'runs', runId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });

    const rawTimeouts = (spec.timeouts as Record<string, unknown> | undefined) ?? {};
    const timeouts: Timeouts = {
      total_s: rawTimeouts.total_s !== undefined ? (rawTimeouts.total_s as number | null) : project.defaults.timeouts.total_s,
      idle_s: rawTimeouts.idle_s !== undefined ? (rawTimeouts.idle_s as number | null) : project.defaults.timeouts.idle_s,
      waiting_s: rawTimeouts.waiting_s !== undefined ? (rawTimeouts.waiting_s as number | null) : (project.defaults.timeouts.waiting_s ?? null),
    };

    const inputMode = resolved.interaction === 'interactive'
      ? (resolved.runner.features.interaction.input === 'stdin' ? 'stdin' : 'resume')
      : 'none';

    const run: Run = {
      id: runId,
      projectId: project.id,
      taskId,
      account: primary.account,
      runner: 'fake',
      state: 'queued',
      reason: null,
      version: 1,
      inputMode,
      role: spec.role as Role,
      model: primary.model,
      reasoningEffort: primary.reasoning_effort,
      reservation: false,
      segment: 0,
      launchAttempts: 0,
      intent: null,
      finalizing: false,
      stop: null,
      candidate: null,
      usage: aggregateUsage({}),
      segmentUsage: {},
      previousSteps: 0,
      protocolViolation: null,
      timeouts,
      clocks: { totalMs: 0, runningSince: null, idleSince: null, waitingSince: null },
      preservation: { state: 'not_required', kind: null, error: null, sha: null },
      protected: false,
      messages: [],
      resumeToken: null,
      cleanupTermAt: null,
      outputDrained: false,
      groupEmpty: false,
      workspaceHead: null,
      hadWorkEvents: false,
      workspace: workspacePath,
      runDir,
      prompt: String(spec.instructions),
      maxSteps: null,
    };
    assertTransition(null, 'queued', 'T1');

    const baseObj = (spec.base as Record<string, unknown> | undefined) ?? { kind: 'branch', ref: project.default_branch };
    const meta: RunMetadata = {
      id: runId,
      task_id: taskId,
      project_id: project.id,
      ref: typeof spec.ref === 'string' ? spec.ref : null,
      role: spec.role as Role,
      title: String(spec.title),
      instructions: String(spec.instructions),
      placement: {
        runner: primary.runner,
        account: primary.account,
        account_requested: (spec.account as string | null | undefined) ?? null,
        degrade: (spec.degrade as RunMetadata['placement']['degrade'] | undefined) ?? [],
        fallbacks: [],
        active_fallback_index: null,
      },
      model_record: {
        requested: String(spec.model),
        resolved: primary.model,
        tier: primary.tier,
        effective: null,
        effective_source: 'unknown',
        auxiliary: [],
        mismatch: false,
      },
      effort_record: {
        requested: String(spec.reasoning_effort),
        resolved_native: primary.resolved_native,
        effective: null,
        effective_source: 'unknown',
        mismatch: false,
      },
      tier_rationale: String(spec.tier_rationale),
      priority: typeof spec.priority === 'number' ? spec.priority : 50,
      critical: Boolean(spec.critical ?? false),
      depends_on: [],
      interaction: resolved.interaction,
      on_interrupt: (spec.on_interrupt as 'notify' | 'auto_continue' | undefined) ?? 'notify',
      base: {
        kind: String(baseObj.kind ?? 'branch'),
        ...(baseObj.ref !== undefined ? { ref: String(baseObj.ref) } : {}),
        sha: typeof baseObj.sha === 'string' ? baseObj.sha : null,
        resolved_at: null,
      },
      workspace_mode: resolved.workspace,
      branch: `${runBranchPrefix}/${runId}`,
      policy: {
        read_only: resolved.read_only,
        read_only_hard: resolved.read_only_hard,
        toolchain_write: resolved.toolchain_write,
        forbidden: Object.keys(primary.forbidden_guarantee),
        forbidden_guarantee: primary.forbidden_guarantee,
      },
      degraded: primary.degraded,
      waivers: [],
      continues: params.continues ?? null,
      continued_by: [],
      lineage: params.lineage ?? { branch_id: runId, forked_from: null, candidate: null, version: 1 },
      created_at: new Date(now).toISOString(),
      created_by: principal.principal,
      started_at: null,
      ended_at: null,
      client_ref: typeof spec.client_ref === 'string' ? spec.client_ref : null,
    };

    return { run, meta, warnings: check.warnings };
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = ulid('req');
    const clientReqIdRaw = req.headers['client-request-id'];
    const clientReqId = Array.isArray(clientReqIdRaw) ? clientReqIdRaw[0] : clientReqIdRaw;
    const baseHeaders: Record<string, string> = { 'Request-Id': requestId };
    if (clientReqId) baseHeaders['Client-Request-Id'] = clientReqId;

    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = normalizePath(url.pathname);

    // O-01: Discovery endpoint (no auth, no version header required)
    if (method === 'GET' && path === '/.well-known/multi-agent-core') {
      sendJson(
        res,
        200,
        {
          service: 'multi-agent-core',
          instance_id: instanceId,
          protocols: {
            supervisor: { versions: [...SUPPORTED_VERSIONS], base_path: '/v0' },
          },
          implementation: { name: 'multi-agent-core', version: implVersion },
        },
        baseHeaders,
      );
      return;
    }

    // All /v0/* endpoints require authentication
    const principal = tokens.authenticate(req);
    if (!principal) {
      sendError(res, {
        status: 401,
        code: 'unauthenticated',
        message: 'Missing, invalid, or expired Bearer token',
        requestId,
        headers: baseHeaders,
      });
      return;
    }

    // Version negotiation
    const isWrite = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
    const ver = negotiateVersion(req, isWrite);
    if (!ver.ok) {
      sendError(res, {
        status: 400,
        code: 'protocol_version_unsupported',
        message: ver.message,
        requestId,
        details: {
          supported: [...SUPPORTED_VERSIONS],
          ...(ver.reason === 'missing' ? { reason: 'missing' } : {}),
        },
        headers: baseHeaders,
      });
      return;
    }

    const respHeaders: Record<string, string> = {
      ...baseHeaders,
      'Supervisor-Protocol': ver.effective,
      ...(ver.warning ? { Warning: ver.warning } : {}),
    };

    const requireScope = (scope: Scope): boolean => {
      if (tokens.hasScope(principal, scope)) return true;
      sendError(res, {
        status: 403,
        code: 'forbidden_scope',
        message: `Token lacks required scope '${scope}'`,
        requestId,
        details: { required: scope },
        headers: respHeaders,
      });
      return false;
    };

    // L4 action endpoints are unconditionally forbidden in Phase 1 / Protocol 0.2
    if (/^\/v0\/(l4\/.*|(runs|tasks)\/[^/]+\/(merge|push|deploy|secrets))$/.test(path)) {
      sendError(res, {
        status: 403,
        code: 'forbidden_scope',
        message: 'L4 actions (merge, push, deploy, modify_secrets) are forbidden in Supervisor Protocol 0.2',
        requestId,
        details: { reason: 'l4_forbidden' },
        headers: respHeaders,
      });
      return;
    }

    // Out-of-phase endpoints -> 501 not_implemented (before idempotency!)
    const outOfPhaseMatch = ((): { op: string; availableIn: string; scope: Scope } | null => {
      if (method === 'POST' && path === '/v0/runs/batch-adjust') {
        return { op: 'POST /v0/runs/batch-adjust', availableIn: 'Phase 3', scope: 'control' };
      }
      if (method === 'GET' && /^\/v0\/tasks\/[^/]+\/reviews$/.test(path)) {
        return { op: 'GET /v0/tasks/{task_id}/reviews', availableIn: 'Phase 4', scope: 'read' };
      }
      if (method === 'GET' && path === '/v0/usage') {
        return { op: 'GET /v0/usage', availableIn: 'Phase 4', scope: 'read' };
      }
      if (method === 'GET' && path === '/v0/approvals') {
        return { op: 'GET /v0/approvals', availableIn: 'Phase 2', scope: 'read' };
      }
      if (method === 'GET' && /^\/v0\/runs\/[^/]+\/context-pack$/.test(path)) {
        return { op: 'GET /v0/runs/{run_id}/context-pack', availableIn: 'Phase 4', scope: 'read' };
      }
      if (method === 'GET' && /^\/v0\/runs\/[^/]+\/artifacts(\/[^/]+)?$/.test(path)) {
        return { op: 'GET /v0/runs/{run_id}/artifacts', availableIn: 'Phase 4', scope: 'read' };
      }
      if (method === 'GET' && /^\/v0\/runs\/[^/]+\/events$/.test(path)) {
        return { op: 'GET /v0/runs/{run_id}/events', availableIn: 'Phase 4', scope: 'read' };
      }
      if (method === 'GET' && /^\/v0\/runs\/[^/]+\/raw$/.test(path)) {
        return { op: 'GET /v0/runs/{run_id}/raw', availableIn: 'Phase 4', scope: 'admin' };
      }
      return null;
    })();

    if (outOfPhaseMatch) {
      if (!requireScope(outOfPhaseMatch.scope)) return;
      sendError(res, {
        status: 501,
        code: 'not_implemented',
        message: `${outOfPhaseMatch.op} is not implemented in Phase 1`,
        requestId,
        details: { operation: outOfPhaseMatch.op, available_in: outOfPhaseMatch.availableIn },
        headers: respHeaders,
      });
      return;
    }

    // GET /v0/events (SSE or JSON catchup)
    if (method === 'GET' && path === '/v0/events') {
      if (!requireScope('read')) return;
      handleEventsEndpoint({
        req,
        res,
        url,
        store,
        principal,
        effectiveVersion: ver.effective,
        requestId,
        extraHeaders: clientReqId ? { 'Client-Request-Id': clientReqId } : {},
        ...(config.keepaliveMs !== undefined ? { keepaliveMs: config.keepaliveMs } : {}),
        ...(config.ssePollMs !== undefined ? { pollMs: config.ssePollMs } : {}),
      });
      return;
    }

    // GET /v0/whoami
    if (method === 'GET' && path === '/v0/whoami') {
      if (!requireScope('read')) return;
      const seq = store.meta().high;
      sendJson(
        res,
        200,
        {
          principal: principal.principal,
          token_id: principal.token_id,
          scopes: principal.scopes,
          projects: principal.projects,
          expires_at: principal.expires_at,
          rate_limit: principal.rate_limit,
        },
        { ...respHeaders, 'Event-Seq': String(seq) },
      );
      return;
    }

    // GET /v0/capabilities
    if (method === 'GET' && path === '/v0/capabilities') {
      if (!requireScope('read')) return;
      const projectLimits: Record<string, number> = {};
      for (const p of config.projects) {
        if (tokens.allowsProject(principal, p.id)) projectLimits[p.id] = p.limits.concurrency;
      }
      const seq = store.meta().high;
      const { payload, etag } = buildCapabilitiesPayload({
        instanceId,
        store,
        runners: config.runners,
        unadmitted: config.unadmitted ?? [],
        projectLimits,
        globalLimit: 6,
      });
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch === etag) {
        res.writeHead(304, { ...respHeaders, ETag: etag, 'Event-Seq': String(seq) });
        res.end();
        return;
      }
      sendJson(res, 200, payload, { ...respHeaders, ETag: etag, 'Event-Seq': String(seq) });
      return;
    }

    // GET /v0/projects & GET /v0/projects/:id
    if (method === 'GET' && path === '/v0/projects') {
      if (!requireScope('read')) return;
      const seq = store.meta().high;
      const items = config.projects
        .filter(p => tokens.allowsProject(principal, p.id))
        .map(p => ({ ...p, workspace_path: undefined }));
      sendJson(res, 200, { items, next_cursor: null }, { ...respHeaders, 'Event-Seq': String(seq) });
      return;
    }

    const projMatch = /^\/v0\/projects\/([^/]+)$/.exec(path);
    if (method === 'GET' && projMatch) {
      if (!requireScope('read')) return;
      const projId = projMatch[1]!;
      const project = projectMap.get(projId);
      if (!project || !tokens.allowsProject(principal, projId)) {
        sendError(res, { status: 404, code: 'not_found', message: 'Project not found', requestId, headers: respHeaders });
        return;
      }
      const seq = store.meta().high;
      sendJson(res, 200, { ...project, workspace_path: undefined }, { ...respHeaders, 'Event-Seq': String(seq) });
      return;
    }

    // Read JSON body for write requests
    let bodyObj: Record<string, unknown> = {};
    if (isWrite) {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendError(res, { status: 400, code: 'invalid_request', message: parsed.message, requestId, headers: respHeaders });
        return;
      }
      if (!parsed.body || typeof parsed.body !== 'object' || Array.isArray(parsed.body)) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Request body must be a JSON object', requestId, headers: respHeaders });
        return;
      }
      bodyObj = parsed.body as Record<string, unknown>;
    }

    // POST /v0/runs/validate
    if (method === 'POST' && path === '/v0/runs/validate') {
      if (!requireScope('submit')) return;
      const unknown = findUnknownFields(bodyObj, ['task_id', 'project_id', 'level', 'runs']);
      if (Array.isArray(bodyObj.runs)) {
        bodyObj.runs.forEach((r, i) => {
          if (r && typeof r === 'object' && !Array.isArray(r)) {
            unknown.push(...collectRunSpecUnknownFields(r as Record<string, unknown>, `runs[${i}]`));
          }
        });
      }
      if (unknown.length > 0) {
        sendError(res, {
          status: 400,
          code: 'invalid_request',
          message: 'Unknown fields in request',
          requestId,
          details: { unknown_fields: unknown },
          headers: respHeaders,
        });
        return;
      }
      if (Array.isArray(bodyObj.runs)) {
        for (let i = 0; i < bodyObj.runs.length; i++) {
          const r = bodyObj.runs[i];
          if (r && typeof r === 'object' && !Array.isArray(r)) {
            const oop = checkRunSpecPhase1(r as Record<string, unknown>, `runs[${i}]`);
            if (oop) {
              sendError(res, {
                status: 501,
                code: 'not_implemented',
                message: 'Request contains fields not implemented in Phase 1',
                requestId,
                details: { paths: oop.paths, available_in: oop.availableIn },
                headers: respHeaders,
              });
              return;
            }
          }
        }
      }
      const projectId = typeof bodyObj.project_id === 'string' ? bodyObj.project_id : null;
      const project = projectId ? projectMap.get(projectId) : undefined;
      if (!project || !tokens.allowsProject(principal, project.id)) {
        sendError(res, {
          status: 403,
          code: 'project_not_authorized',
          message: 'Project not found or not authorized',
          requestId,
          headers: respHeaders,
        });
        return;
      }
      const level = (bodyObj.level ?? 'L2') as Level;
      const violations: Violation[] = [...validateTaskLevel(level, project)];
      const warnings: WarningItem[] = [];
      const resolvedList: unknown[] = [];
      const runsInput = Array.isArray(bodyObj.runs) ? bodyObj.runs : [];
      runsInput.forEach((r, i) => {
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
          violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `runs[${i}]`, message: 'RunSpec must be an object' });
          return;
        }
        const resRun = validateRunSpec({
          spec: r as Record<string, unknown>,
          pathPrefix: `runs[${i}]`,
          taskLevel: level,
          project,
          runners: config.runners,
        });
        violations.push(...resRun.violations);
        warnings.push(...resRun.warnings);
        if (resRun.resolved) {
          resolvedList.push({
            ref: (r as Record<string, unknown>).ref ?? null,
            candidates: resRun.resolved.candidates.map(c => ({
              runner: c.runner,
              account: c.account,
              model: c.model,
              reasoning_effort: c.reasoning_effort,
              account_status: c.account_status,
            })),
          });
        }
      });
      sendJson(res, 200, { ok: violations.length === 0, violations, warnings, resolved: resolvedList }, respHeaders);
      return;
    }

    // Helper for Idempotency-Key wrapped write handlers
    const withIdempotency = async (
      permanent: boolean,
      fn: (scope: IdempotencyScope) => Promise<{ status: number; body: unknown; headers?: Record<string, string>; alreadyCommittedInTx?: boolean }>,
    ): Promise<void> => {
      const keyCheck = validateIdempotencyKey(req.headers['idempotency-key']);
      if (!keyCheck.ok) {
        sendError(res, { status: 400, code: keyCheck.code, message: keyCheck.message, requestId, headers: respHeaders });
        return;
      }
      const scope: IdempotencyScope = {
        principal: principal.principal,
        method,
        path,
        key: keyCheck.key,
      };
      const fingerprint = computeRequestFingerprint({
        protocol: ver.effective,
        method,
        path,
        query: queryToObject(url),
        body: bodyObj,
      });

      const acquired = idempotency.checkAndAcquire(scope, fingerprint, requestId, permanent);
      if (acquired.action === 'replay') {
        sendJson(res, acquired.statusCode, acquired.body, { ...respHeaders, 'Idempotent-Replayed': 'true' });
        return;
      }
      if (acquired.action === 'conflict') {
        sendError(res, {
          status: 409,
          code: 'idempotency_conflict',
          message: 'Idempotency-Key reused with different request fingerprint',
          requestId,
          details: { first_request_id: acquired.firstRequestId, first_requested_at: acquired.firstRequestedAt },
          headers: respHeaders,
        });
        return;
      }
      if (acquired.action === 'in_progress') {
        sendError(res, {
          status: 409,
          code: 'idempotency_in_progress',
          message: 'A request with this Idempotency-Key is currently in progress',
          retryable: true,
          retry_after_s: 1,
          requestId,
          headers: respHeaders,
        });
        return;
      }

      try {
        const result = await fn(scope);
        const bodyStr = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
        if (shouldRecordStatus(result.status)) {
          if (!result.alreadyCommittedInTx) {
            idempotency.completeStandalone(scope, result.status, bodyStr);
          }
          idempotency.releaseInFlight(scope, false);
        } else {
          idempotency.releaseInFlight(scope, true);
        }
        sendJson(res, result.status, bodyStr, { ...respHeaders, ...(result.headers ?? {}) });
      } catch (err) {
        idempotency.releaseInFlight(scope, true);
        sendError(res, {
          status: 500,
          code: 'internal',
          message: err instanceof Error ? err.message : 'Internal server error',
          retryable: true,
          requestId,
          headers: respHeaders,
        });
      }
    };

    // O-06: POST /v0/tasks
    if (method === 'POST' && path === '/v0/tasks') {
      if (!requireScope('submit')) return;
      const unknown = collectTaskCreateUnknownFields(bodyObj);
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields in request', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      const oop = checkTaskCreatePhase1(bodyObj);
      if (oop) {
        sendError(res, { status: 501, code: 'not_implemented', message: 'Request contains fields not implemented in Phase 1', requestId, details: { paths: oop.paths, available_in: oop.availableIn }, headers: respHeaders });
        return;
      }

      await withIdempotency(true, async scope => {
        const projectId = bodyObj.project_id;
        if (typeof projectId !== 'string' || !projectMap.has(projectId) || !tokens.allowsProject(principal, projectId)) {
          return {
            status: 403,
            body: {
              error: {
                code: 'project_not_authorized',
                message: 'Project not authorized or unknown',
                retryable: false,
                retry_after_s: null,
                request_id: requestId,
              },
            },
          };
        }
        const project = projectMap.get(projectId)!;

        // client_ref check (Layer 2 permanent dedup)
        const clientRef = bodyObj.client_ref !== undefined ? bodyObj.client_ref : null;
        if (clientRef !== null && (typeof clientRef !== 'string' || clientRef.length < 1 || clientRef.length > 128)) {
          return {
            status: 400,
            body: { error: { code: 'invalid_request', message: 'client_ref must be 1..128 chars', retryable: false, retry_after_s: null, request_id: requestId } },
          };
        }
        const bodyFingerprint = sha256Hex(canonicalJson(bodyObj));
        if (clientRef !== null) {
          const existing = store.db
            .prepare('SELECT id, request_fingerprint, payload FROM api_tasks WHERE principal=? AND project_id=? AND client_ref=?')
            .get(principal.principal, projectId, clientRef) as { id: string; request_fingerprint: string; payload: string } | undefined;
          if (existing) {
            if (existing.request_fingerprint === bodyFingerprint) {
              const task = JSON.parse(existing.payload) as TaskRecord;
              const taskRuns = task.run_ids.map(rid => {
                const r = store.get(rid);
                return serializeRun(r, getRunMeta(rid)!, getReleaseState(store, rid));
              });
              const respBody = { task: serializeTask(task, task.run_ids.map(rid => store.get(rid))), runs: taskRuns, warnings: [] };
              const respStr = JSON.stringify(respBody);
              store.transaction(() => {
                idempotency.completeInTransaction(scope, 200, respStr);
              });
              return { status: 200, body: respStr, headers: { 'Client-Ref-Replayed': 'true' }, alreadyCommittedInTx: true };
            }
            return {
              status: 409,
              body: {
                error: {
                  code: 'duplicate_client_ref',
                  message: 'client_ref already used by a different task',
                  retryable: false,
                  retry_after_s: null,
                  request_id: requestId,
                  details: { existing_task_id: existing.id },
                },
              },
            };
          }
        }

        // Validate task fields + runs
        const violations: Violation[] = [];
        const warnings: WarningItem[] = [];
        if (typeof bodyObj.title !== 'string' || bodyObj.title.length < 1 || bodyObj.title.length > 120) {
          violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: 'title', message: 'title must be 1..120 chars' });
        }
        if (typeof bodyObj.goal !== 'string' || bodyObj.goal.length < 1 || Buffer.byteLength(bodyObj.goal) > 20 * 1024) {
          violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: 'goal', message: 'goal must be 1..20KiB' });
        }
        const constraints = bodyObj.constraints ?? [];
        if (!Array.isArray(constraints) || constraints.length > 50 || constraints.some(c => typeof c !== 'string' || Buffer.byteLength(c) > 2048)) {
          violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: 'constraints', message: 'constraints must be <= 50 strings each <= 2 KiB' });
        }
        violations.push(...validateTaskLevel(bodyObj.level, project));

        const runsInput = bodyObj.runs ?? [];
        if (!Array.isArray(runsInput) || runsInput.length > 50) {
          violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: 'runs', message: 'runs must be an array of <= 50 RunSpecs' });
        } else {
          const seenRunRefs = new Set<string>();
          runsInput.forEach((r, i) => {
            if (!r || typeof r !== 'object' || Array.isArray(r)) {
              violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `runs[${i}]`, message: 'RunSpec must be an object' });
              return;
            }
            const spec = r as Record<string, unknown>;
            if (typeof spec.client_ref === 'string') {
              if (seenRunRefs.has(spec.client_ref)) {
                violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `runs[${i}].client_ref`, message: 'Duplicate run client_ref in batch' });
              }
              seenRunRefs.add(spec.client_ref);
            }
            if (violations.every(v => v.path !== 'level')) {
              const resRun = validateRunSpec({
                spec,
                pathPrefix: `runs[${i}]`,
                taskLevel: bodyObj.level as Level,
                project,
                runners: config.runners,
              });
              violations.push(...resRun.violations);
              warnings.push(...resRun.warnings);
            }
          });
        }

        if (violations.length > 0) {
          const hasOnlySchema = violations.every(v => v.rule === 'SCHEMA_INVALID');
          const status = hasOnlySchema ? 400 : 422;
          const code = hasOnlySchema ? 'invalid_request' : 'validation_failed';
          return {
            status,
            body: {
              error: {
                code,
                message: `${violations.length} validation error(s); no resources created`,
                retryable: false,
                retry_after_s: null,
                request_id: requestId,
                ...(hasOnlySchema ? {} : { violations }),
              },
            },
          };
        }

        const now = Date.now();
        const taskId = ulid('task', now);
        const createdRuns: { run: Run; meta: RunMetadata }[] = [];
        for (const r of runsInput as Record<string, unknown>[]) {
          const runId = ulid('run', now);
          const built = buildRunFromSpec({ runId, taskId, project, spec: r, principal, now });
          createdRuns.push({ run: built.run, meta: built.meta });
        }

        const task: TaskRecord = {
          id: taskId,
          object: 'task',
          project_id: projectId,
          title: String(bodyObj.title),
          goal: String(bodyObj.goal),
          constraints: (constraints as string[]).slice(),
          level: bodyObj.level as Level,
          budget: null,
          state: 'open',
          outcome: null,
          run_ids: createdRuns.map(x => x.run.id),
          client_ref: clientRef,
          created_at: new Date(now).toISOString(),
          created_by: principal.principal,
          closed_at: null,
          version: 1,
        };

        const respPayload = {
          task: serializeTask(task, createdRuns.map(x => x.run)),
          runs: createdRuns.map(x => serializeRun(x.run, x.meta, null)),
          warnings,
        };
        const respStr = JSON.stringify(respPayload);

        store.transaction(() => {
          store.db
            .prepare('INSERT INTO api_tasks(id, project_id, principal, client_ref, request_fingerprint, payload, created_at) VALUES (?,?,?,?,?,?,?)')
            .run(task.id, task.project_id, principal.principal, clientRef, bodyFingerprint, JSON.stringify(task), now);
          store.emit('task.created', { task: respPayload.task, version: 1 }, null, now);
          for (let i = 0; i < createdRuns.length; i++) {
            const { run, meta } = createdRuns[i]!;
            const specFp = sha256Hex(canonicalJson((runsInput as unknown[])[i]));
            store.put(run);
            store.db
              .prepare('INSERT INTO api_runs(id, task_id, project_id, client_ref, spec_fingerprint, payload, created_at) VALUES (?,?,?,?,?,?,?)')
              .run(run.id, task.id, project.id, meta.client_ref, specFp, JSON.stringify(meta), now);
            store.emit('run.created', { run: respPayload.runs[i], version: run.version }, run, now);
            stateEvent(store, run, null, now);
          }
          idempotency.completeInTransaction(scope, 201, respStr, now);
        });

        return { status: 201, body: respStr, alreadyCommittedInTx: true };
      });
      return;
    }

    // O-07: GET /v0/tasks
    if (method === 'GET' && path === '/v0/tasks') {
      if (!requireScope('read')) return;
      const filterProj = url.searchParams.get('project_id');
      const filterState = url.searchParams.get('state');
      const filterClientRef = url.searchParams.get('client_ref');
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));

      const { items, seq } = store.transaction(() => {
        const high = store.meta().high;
        const rows = store.db.prepare('SELECT payload FROM api_tasks ORDER BY created_at DESC, rowid DESC').all() as { payload: string }[];
        const list: Record<string, unknown>[] = [];
        for (const row of rows) {
          const t = JSON.parse(row.payload) as TaskRecord;
          if (!tokens.allowsProject(principal, t.project_id)) continue;
          if (filterProj && t.project_id !== filterProj) continue;
          if (filterState && t.state !== filterState) continue;
          if (filterClientRef && t.client_ref !== filterClientRef) continue;
          const runs = t.run_ids.map(rid => store.get(rid));
          list.push(serializeTask(t, runs));
          if (list.length >= limit) break;
        }
        return { items: list, seq: high };
      });

      sendJson(res, 200, { items, next_cursor: null }, { ...respHeaders, 'Event-Seq': String(seq) });
      return;
    }

    // O-07: GET /v0/tasks/:id
    const taskMatch = /^\/v0\/tasks\/([^/]+)$/.exec(path);
    if (method === 'GET' && taskMatch) {
      if (!requireScope('read')) return;
      const taskId = taskMatch[1]!;
      const { task, runs, seq } = store.transaction(() => {
        const high = store.meta().high;
        const row = getTaskRow(taskId);
        if (!row) return { task: null, runs: [], seq: high };
        const t = JSON.parse(row.payload) as TaskRecord;
        if (!tokens.allowsProject(principal, t.project_id)) return { task: null, runs: [], seq: high };
        const rList = t.run_ids.map(rid => store.get(rid));
        return { task: t, runs: rList, seq: high };
      });
      if (!task) {
        sendError(res, { status: 404, code: 'not_found', message: 'Task not found', requestId, headers: respHeaders });
        return;
      }
      sendJson(
        res,
        200,
        serializeTask(task, runs),
        { ...respHeaders, ETag: `"${task.version}"`, 'Event-Seq': String(seq) },
      );
      return;
    }

    // O-08: PATCH /v0/tasks/:id
    if (method === 'PATCH' && taskMatch) {
      if (!requireScope('control')) return;
      const taskId = taskMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['title', 'budget']);
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields in request', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      if (bodyObj.budget !== undefined) {
        sendError(res, { status: 501, code: 'not_implemented', message: 'Task budget is not implemented in Phase 1', requestId, details: { paths: ['budget'], available_in: 'Phase 3' }, headers: respHeaders });
        return;
      }
      const ifMatch = req.headers['if-match'];
      if (!ifMatch || Array.isArray(ifMatch)) {
        sendError(res, { status: 412, code: 'precondition_required', message: 'Missing If-Match header', requestId, headers: respHeaders });
        return;
      }
      const row = getTaskRow(taskId);
      if (!row) {
        sendError(res, { status: 404, code: 'not_found', message: 'Task not found', requestId, headers: respHeaders });
        return;
      }
      const task = JSON.parse(row.payload) as TaskRecord;
      if (!tokens.allowsProject(principal, task.project_id)) {
        sendError(res, { status: 404, code: 'not_found', message: 'Task not found', requestId, headers: respHeaders });
        return;
      }
      if (ifMatch !== `"${task.version}"`) {
        sendError(res, { status: 409, code: 'version_conflict', message: 'Task version mismatch', requestId, headers: respHeaders });
        return;
      }
      if (bodyObj.title !== undefined) {
        if (typeof bodyObj.title !== 'string' || bodyObj.title.length < 1 || bodyObj.title.length > 120) {
          sendError(res, { status: 400, code: 'invalid_request', message: 'title must be 1..120 chars', requestId, headers: respHeaders });
          return;
        }
        task.title = bodyObj.title;
      }
      task.version++;
      const serialized = store.transaction(() => {
        store.db.prepare('UPDATE api_tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
        const s = serializeTask(task, task.run_ids.map(rid => store.get(rid)));
        store.emit('task.updated', { task: s, version: task.version }, null);
        return s;
      });
      sendJson(res, 200, serialized, { ...respHeaders, ETag: `"${task.version}"` });
      return;
    }

    // O-09: POST /v0/tasks/:id/runs
    const taskRunsMatch = /^\/v0\/tasks\/([^/]+)\/runs$/.exec(path);
    if (method === 'POST' && taskRunsMatch) {
      if (!requireScope('submit')) return;
      const taskId = taskRunsMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['runs']);
      if (Array.isArray(bodyObj.runs)) {
        bodyObj.runs.forEach((r, i) => {
          if (r && typeof r === 'object' && !Array.isArray(r)) {
            unknown.push(...collectRunSpecUnknownFields(r as Record<string, unknown>, `runs[${i}]`));
          }
        });
      }
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields in request', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      if (Array.isArray(bodyObj.runs)) {
        for (let i = 0; i < bodyObj.runs.length; i++) {
          const r = bodyObj.runs[i];
          if (r && typeof r === 'object' && !Array.isArray(r)) {
            const oop = checkRunSpecPhase1(r as Record<string, unknown>, `runs[${i}]`);
            if (oop) {
              sendError(res, { status: 501, code: 'not_implemented', message: 'Request contains fields not implemented in Phase 1', requestId, details: { paths: oop.paths, available_in: oop.availableIn }, headers: respHeaders });
              return;
            }
          }
        }
      }

      await withIdempotency(true, async scope => {
        const row = getTaskRow(taskId);
        if (!row) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Task not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const task = JSON.parse(row.payload) as TaskRecord;
        if (!tokens.allowsProject(principal, task.project_id)) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Task not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        if (task.state !== 'open') {
          return { status: 409, body: { error: { code: 'invalid_state', message: `Task is ${task.state}, cannot append runs`, retryable: false, retry_after_s: null, request_id: requestId, details: { state: task.state } } } };
        }
        const project = projectMap.get(task.project_id)!;
        const runsInput = bodyObj.runs;
        if (!Array.isArray(runsInput) || runsInput.length === 0 || runsInput.length > 50) {
          return { status: 400, body: { error: { code: 'invalid_request', message: 'runs must be a non-empty array of <= 50 RunSpecs', retryable: false, retry_after_s: null, request_id: requestId } } };
        }

        // Check run client_ref uniqueness within task
        for (const r of runsInput) {
          if (r && typeof r === 'object' && typeof (r as Record<string, unknown>).client_ref === 'string') {
            const cr = (r as Record<string, unknown>).client_ref as string;
            const dup = store.db.prepare('SELECT id, spec_fingerprint FROM api_runs WHERE task_id=? AND client_ref=?').get(task.id, cr) as { id: string; spec_fingerprint: string } | undefined;
            if (dup) {
              const sameBody = dup.spec_fingerprint === sha256Hex(canonicalJson(r));
              return {
                status: 409,
                body: {
                  error: {
                    code: 'duplicate_client_ref',
                    message: 'Run client_ref already exists in task',
                    retryable: false,
                    retry_after_s: null,
                    request_id: requestId,
                    details: { existing_run_id: dup.id, same_body: sameBody },
                  },
                },
              };
            }
          }
        }

        const violations: Violation[] = [];
        const warnings: WarningItem[] = [];
        runsInput.forEach((r, i) => {
          if (!r || typeof r !== 'object' || Array.isArray(r)) {
            violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `runs[${i}]`, message: 'RunSpec must be an object' });
            return;
          }
          const resRun = validateRunSpec({ spec: r as Record<string, unknown>, pathPrefix: `runs[${i}]`, taskLevel: task.level, project, runners: config.runners });
          violations.push(...resRun.violations);
          warnings.push(...resRun.warnings);
        });
        if (violations.length > 0) {
          return {
            status: 422,
            body: { error: { code: 'validation_failed', message: `${violations.length} validation error(s)`, retryable: false, retry_after_s: null, request_id: requestId, violations } },
          };
        }

        const now = Date.now();
        const createdRuns: { run: Run; meta: RunMetadata }[] = [];
        for (const r of runsInput as Record<string, unknown>[]) {
          const runId = ulid('run', now);
          const built = buildRunFromSpec({ runId, taskId: task.id, project, spec: r, principal, now });
          createdRuns.push({ run: built.run, meta: built.meta });
        }
        task.run_ids.push(...createdRuns.map(x => x.run.id));
        task.version++;
        const respRuns = createdRuns.map(x => serializeRun(x.run, x.meta, null));
        const respStr = JSON.stringify({ runs: respRuns, warnings });

        store.transaction(() => {
          store.db.prepare('UPDATE api_tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
          for (let i = 0; i < createdRuns.length; i++) {
            const { run, meta } = createdRuns[i]!;
            const specFp = sha256Hex(canonicalJson(runsInput[i]));
            store.put(run);
            store.db
              .prepare('INSERT INTO api_runs(id, task_id, project_id, client_ref, spec_fingerprint, payload, created_at) VALUES (?,?,?,?,?,?,?)')
              .run(run.id, task.id, project.id, meta.client_ref, specFp, JSON.stringify(meta), now);
            store.emit('run.created', { run: respRuns[i], version: run.version }, run, now);
            stateEvent(store, run, null, now);
          }
          idempotency.completeInTransaction(scope, 201, respStr, now);
        });

        return { status: 201, body: respStr, alreadyCommittedInTx: true };
      });
      return;
    }

    // O-11: POST /v0/tasks/:id/cancel
    const taskCancelMatch = /^\/v0\/tasks\/([^/]+)\/cancel$/.exec(path);
    if (method === 'POST' && taskCancelMatch) {
      if (!requireScope('control')) return;
      const taskId = taskCancelMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['reason']);
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      await withIdempotency(false, async () => {
        const row = getTaskRow(taskId);
        if (!row) return { status: 404, body: { error: { code: 'not_found', message: 'Task not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        const task = JSON.parse(row.payload) as TaskRecord;
        if (!tokens.allowsProject(principal, task.project_id)) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Task not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        if (task.state !== 'open') {
          return { status: 409, body: { error: { code: 'invalid_state', message: `Task is already ${task.state}`, retryable: false, retry_after_s: null, request_id: requestId, details: { state: task.state } } } };
        }
        const reason = typeof bodyObj.reason === 'string' && bodyObj.reason.length > 0 ? bodyObj.reason : 'task_cancelled';
        const now = Date.now();
        for (const rid of task.run_ids) {
          const r = store.get(rid);
          if (!isTerminal(r.state)) {
            try { runtime.stop(rid, 'cancel', now, false, reason); } catch { /* ignore if finalizing */ }
          }
        }
        task.state = 'cancelled';
        task.closed_at = new Date(now).toISOString();
        task.version++;
        const serialized = store.transaction(() => {
          store.db.prepare('UPDATE api_tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
          const s = serializeTask(task, task.run_ids.map(rid => store.get(rid)));
          store.emit('task.cancelled', { outcome: { reason }, version: task.version }, null, now);
          return s;
        });
        return { status: 200, body: serialized };
      });
      return;
    }

    // O-10: POST /v0/tasks/:id/close
    const taskCloseMatch = /^\/v0\/tasks\/([^/]+)\/close$/.exec(path);
    if (method === 'POST' && taskCloseMatch) {
      if (!requireScope('decide')) return;
      const taskId = taskCloseMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['outcome', 'accepted', 'note', 'cancel_open_runs']);
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      if (bodyObj.outcome === 'accepted') {
        sendError(res, { status: 501, code: 'not_implemented', message: 'close with outcome=accepted is not implemented in Phase 1', requestId, details: { paths: ['outcome'], available_in: 'Phase 4' }, headers: respHeaders });
        return;
      }
      await withIdempotency(false, async scope => {
        const row = getTaskRow(taskId);
        if (!row) return { status: 404, body: { error: { code: 'not_found', message: 'Task not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        const task = JSON.parse(row.payload) as TaskRecord;
        if (!tokens.allowsProject(principal, task.project_id)) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Task not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        if (task.state !== 'open') {
          return { status: 409, body: { error: { code: 'invalid_state', message: `Task is ${task.state}`, retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        if (!['abandoned', 'superseded'].includes(String(bodyObj.outcome))) {
          return { status: 400, body: { error: { code: 'invalid_request', message: 'Invalid outcome', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const runs = task.run_ids.map(rid => store.get(rid));
        if (runs.some(r => !isTerminal(r.state)) && !bodyObj.cancel_open_runs) {
          return { status: 409, body: { error: { code: 'invalid_state', message: 'Task still has non-terminal runs', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const now = Date.now();
        task.state = 'closed';
        task.outcome = { outcome: bodyObj.outcome, note: bodyObj.note ?? null };
        task.closed_at = new Date(now).toISOString();
        task.version++;
        const respStr = JSON.stringify(serializeTask(task, runs));
        store.transaction(() => {
          store.db.prepare('UPDATE api_tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
          store.emit('task.closed', { outcome: task.outcome, version: task.version }, null, now);
          idempotency.completeInTransaction(scope, 200, respStr, now);
        });
        return { status: 200, body: respStr, alreadyCommittedInTx: true };
      });
      return;
    }

    // O-27 / O-28: POST/GET /v0/tasks/:id/rulings
    const taskRulingsMatch = /^\/v0\/tasks\/([^/]+)\/rulings$/.exec(path);
    if (method === 'GET' && taskRulingsMatch) {
      if (!requireScope('read')) return;
      const taskId = taskRulingsMatch[1]!;
      const row = getTaskRow(taskId);
      if (!row) {
        sendError(res, { status: 404, code: 'not_found', message: 'Task not found', requestId, headers: respHeaders });
        return;
      }
      const task = JSON.parse(row.payload) as TaskRecord;
      if (!tokens.allowsProject(principal, task.project_id)) {
        sendError(res, { status: 404, code: 'not_found', message: 'Task not found', requestId, headers: respHeaders });
        return;
      }
      const { items, seq } = store.transaction(() => {
        const high = store.meta().high;
        const rows = store.db.prepare('SELECT payload FROM api_rulings WHERE task_id=? ORDER BY created_at DESC, rowid DESC').all(taskId) as { payload: string }[];
        return { items: rows.map(r => JSON.parse(r.payload)), seq: high };
      });
      sendJson(res, 200, { items, next_cursor: null }, { ...respHeaders, 'Event-Seq': String(seq) });
      return;
    }

    if (method === 'POST' && taskRulingsMatch) {
      if (!requireScope('decide')) return;
      const taskId = taskRulingsMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['subject', 'decision', 'based_on', 'expected_branch_version', 'note']);
      if (bodyObj.subject && typeof bodyObj.subject === 'object' && !Array.isArray(bodyObj.subject)) {
        unknown.push(...findUnknownFields(bodyObj.subject, ['run_id', 'sha'], 'subject'));
      }
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      await withIdempotency(true, async scope => {
        const row = getTaskRow(taskId);
        if (!row) return { status: 404, body: { error: { code: 'not_found', message: 'Task not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        const task = JSON.parse(row.payload) as TaskRecord;
        if (!tokens.allowsProject(principal, task.project_id)) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Task not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const subject = bodyObj.subject as { run_id?: unknown; sha?: unknown } | undefined;
        const decision = bodyObj.decision;
        if (!subject || typeof subject.run_id !== 'string' || typeof subject.sha !== 'string' || !['accept', 'accept_with_notes', 'rework', 'reject'].includes(String(decision))) {
          return { status: 400, body: { error: { code: 'invalid_request', message: 'Invalid subject or decision', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const subjectRunId = subject.run_id;
        const runMeta = getRunMeta(subjectRunId);
        if (!runMeta || runMeta.task_id !== task.id) {
          return { status: 422, body: { error: { code: 'validation_failed', message: 'Subject run does not belong to this task', retryable: false, retry_after_s: null, request_id: requestId, violations: [{ rule: 'REF_UNKNOWN', kind: 'dependency', path: 'subject.run_id', message: 'Run not found in task' }] } } };
        }
        const branchVersion = runMeta.lineage?.version ?? 1;
        if (bodyObj.expected_branch_version !== undefined && bodyObj.expected_branch_version !== branchVersion) {
          return { status: 409, body: { error: { code: 'version_conflict', message: 'Branch version conflict', retryable: true, retry_after_s: null, request_id: requestId } } };
        }
        const now = Date.now();
        const ruling: RulingRecord = {
          id: ulid('rul', now),
          object: 'ruling',
          task_id: task.id,
          subject: { run_id: subjectRunId, sha: subject.sha },
          branch: { id: runMeta.lineage?.branch_id ?? subjectRunId, version: branchVersion },
          decision: decision as RulingRecord['decision'],
          based_on: Array.isArray(bodyObj.based_on) ? (bodyObj.based_on as string[]) : [],
          note: typeof bodyObj.note === 'string' ? bodyObj.note : null,
          by: principal.principal,
          at: new Date(now).toISOString(),
          status: 'effective',
          version: 1,
        };
        const respStr = JSON.stringify(ruling);
        store.transaction(() => {
          store.db.prepare('INSERT INTO api_rulings(id, task_id, project_id, payload, created_at) VALUES (?,?,?,?,?)').run(ruling.id, task.id, task.project_id, respStr, now);
          store.emit('ruling.recorded', { ruling, version: ruling.version }, store.get(subjectRunId), now);
          idempotency.completeInTransaction(scope, 201, respStr, now);
        });
        return { status: 201, body: respStr, alreadyCommittedInTx: true };
      });
      return;
    }

    // O-29 / O-30: POST/GET /v0/tasks/:id/journal
    const taskJournalMatch = /^\/v0\/tasks\/([^/]+)\/journal$/.exec(path);
    if (method === 'GET' && taskJournalMatch) {
      if (!requireScope('read')) return;
      const taskId = taskJournalMatch[1]!;
      const row = getTaskRow(taskId);
      if (!row) {
        sendError(res, { status: 404, code: 'not_found', message: 'Task not found', requestId, headers: respHeaders });
        return;
      }
      const task = JSON.parse(row.payload) as TaskRecord;
      if (!tokens.allowsProject(principal, task.project_id)) {
        sendError(res, { status: 404, code: 'not_found', message: 'Task not found', requestId, headers: respHeaders });
        return;
      }
      const { items, seq } = store.transaction(() => {
        const high = store.meta().high;
        const rows = store.db.prepare('SELECT payload FROM api_journal WHERE task_id=? ORDER BY created_at DESC, rowid DESC').all(taskId) as { payload: string }[];
        return { items: rows.map(r => JSON.parse(r.payload)), seq: high };
      });
      sendJson(res, 200, { items, next_cursor: null }, { ...respHeaders, 'Event-Seq': String(seq) });
      return;
    }

    if (method === 'POST' && taskJournalMatch) {
      if (!requireScope('control')) return;
      const taskId = taskJournalMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['kind', 'data']);
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      await withIdempotency(true, async scope => {
        const row = getTaskRow(taskId);
        if (!row) return { status: 404, body: { error: { code: 'not_found', message: 'Task not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        const task = JSON.parse(row.payload) as TaskRecord;
        if (!tokens.allowsProject(principal, task.project_id)) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Task not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        if (!['intervention', 'decision', 'anomaly', 'note'].includes(String(bodyObj.kind)) || !bodyObj.data || typeof bodyObj.data !== 'object') {
          return { status: 400, body: { error: { code: 'invalid_request', message: 'Invalid journal kind or data', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const now = Date.now();
        const entry: JournalRecord = {
          id: ulid('jnl', now),
          task_id: task.id,
          kind: bodyObj.kind as JournalRecord['kind'],
          data: bodyObj.data as Record<string, unknown>,
          by: principal.principal,
          at: new Date(now).toISOString(),
        };
        const respStr = JSON.stringify(entry);
        store.transaction(() => {
          store.db.prepare('INSERT INTO api_journal(id, task_id, project_id, payload, created_at) VALUES (?,?,?,?,?)').run(entry.id, task.id, task.project_id, respStr, now);
          store.emit('journal.appended', { entry }, null, now);
          idempotency.completeInTransaction(scope, 201, respStr, now);
        });
        return { status: 201, body: respStr, alreadyCommittedInTx: true };
      });
      return;
    }

    // O-12: GET /v0/runs
    if (method === 'GET' && path === '/v0/runs') {
      if (!requireScope('read')) return;
      const fTask = url.searchParams.get('task_id');
      const fProj = url.searchParams.get('project_id');
      const fState = url.searchParams.get('state');
      const fRole = url.searchParams.get('role');
      const fRunner = url.searchParams.get('runner');
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));

      const { items, seq } = store.transaction(() => {
        const high = store.meta().high;
        const all = store.list();
        const out: Record<string, unknown>[] = [];
        for (let i = all.length - 1; i >= 0; i--) {
          const r = all[i]!;
          if (!tokens.allowsProject(principal, r.projectId)) continue;
          const meta = getRunMeta(r.id);
          if (!meta) continue;
          if (fTask && r.taskId !== fTask) continue;
          if (fProj && r.projectId !== fProj) continue;
          if (fState && r.state !== fState) continue;
          if (fRole && r.role !== fRole) continue;
          if (fRunner && meta.placement.runner !== fRunner) continue;
          out.push(serializeRun(r, meta, getReleaseState(store, r.id)));
          if (out.length >= limit) break;
        }
        return { items: out, seq: high };
      });
      sendJson(res, 200, { items, next_cursor: null }, { ...respHeaders, 'Event-Seq': String(seq) });
      return;
    }

    // O-12: GET /v0/runs/:id
    const runMatch = /^\/v0\/runs\/([^/]+)$/.exec(path);
    if (method === 'GET' && runMatch) {
      if (!requireScope('read')) return;
      const runId = runMatch[1]!;
      const { item, seq, version } = store.transaction(() => {
        const high = store.meta().high;
        const meta = getRunMeta(runId);
        if (!meta || !tokens.allowsProject(principal, meta.project_id)) return { item: null, seq: high, version: 0 };
        const run = store.get(runId);
        return { item: serializeRun(run, meta, getReleaseState(store, runId)), seq: high, version: run.version };
      });
      if (!item) {
        sendError(res, { status: 404, code: 'not_found', message: 'Run not found', requestId, headers: respHeaders });
        return;
      }
      sendJson(res, 200, item, { ...respHeaders, ETag: `"${version}"`, 'Event-Seq': String(seq) });
      return;
    }

    // O-22: GET /v0/runs/:id/result
    const runResultMatch = /^\/v0\/runs\/([^/]+)\/result$/.exec(path);
    if (method === 'GET' && runResultMatch) {
      if (!requireScope('read')) return;
      const runId = runResultMatch[1]!;
      const { result, seq } = store.transaction(() => {
        const high = store.meta().high;
        const meta = getRunMeta(runId);
        if (!meta || !tokens.allowsProject(principal, meta.project_id)) return { result: undefined, seq: high };
        const run = store.get(runId);
        return { result: serializeRunResult(run, meta), seq: high };
      });
      if (result === undefined) {
        sendError(res, { status: 404, code: 'not_found', message: 'Run not found', requestId, headers: respHeaders });
        return;
      }
      sendJson(res, 200, result, { ...respHeaders, 'Event-Seq': String(seq) });
      return;
    }

    // O-13: PATCH /v0/runs/:id
    if (method === 'PATCH' && runMatch) {
      if (!requireScope('control')) return;
      const runId = runMatch[1]!;
      const allowedPatch = ['title', 'priority', 'critical', 'depends_on', 'runner', 'account', 'fallbacks', 'model', 'reasoning_effort', 'tier_rationale', 'budget', 'timeouts', 'degrade', 'waivers'];
      const unknown = findUnknownFields(bodyObj, allowedPatch);
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      const oop = checkRunSpecPhase1(bodyObj, '');
      if (oop) {
        sendError(res, { status: 501, code: 'not_implemented', message: 'PATCH contains fields not implemented in Phase 1', requestId, details: { paths: oop.paths.map(p => p.replace(/^\./, '')), available_in: oop.availableIn }, headers: respHeaders });
        return;
      }
      const ifMatch = req.headers['if-match'];
      if (!ifMatch || Array.isArray(ifMatch)) {
        sendError(res, { status: 412, code: 'precondition_required', message: 'Missing If-Match header', requestId, headers: respHeaders });
        return;
      }
      const meta = getRunMeta(runId);
      if (!meta || !tokens.allowsProject(principal, meta.project_id)) {
        sendError(res, { status: 404, code: 'not_found', message: 'Run not found', requestId, headers: respHeaders });
        return;
      }
      const run = store.get(runId);
      if (!['queued', 'blocked', 'held'].includes(run.state)) {
        sendError(res, { status: 409, code: 'invalid_state', message: `Cannot PATCH run in state ${run.state}`, requestId, details: { state: run.state, allowed: allowedOpsForState(run.state) }, headers: respHeaders });
        return;
      }
      if (ifMatch !== `"${run.version}"`) {
        sendError(res, { status: 409, code: 'version_conflict', message: 'Run version mismatch', requestId, headers: respHeaders });
        return;
      }
      if (bodyObj.title !== undefined) meta.title = String(bodyObj.title);
      if (bodyObj.critical !== undefined) meta.critical = Boolean(bodyObj.critical);
      run.version++;
      const serialized = store.transaction(() => {
        store.put(run);
        store.db.prepare('UPDATE api_runs SET payload=? WHERE id=?').run(JSON.stringify(meta), run.id);
        store.emit('run.updated', { version: run.version, changes: bodyObj }, run);
        return serializeRun(run, meta, getReleaseState(store, run.id));
      });
      sendJson(res, 200, serialized, { ...respHeaders, ETag: `"${run.version}"` });
      return;
    }

    // O-14: POST /v0/runs/:id/cancel
    const runCancelMatch = /^\/v0\/runs\/([^/]+)\/cancel$/.exec(path);
    if (method === 'POST' && runCancelMatch) {
      if (!requireScope('control')) return;
      const runId = runCancelMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['reason', 'preserve_wip', 'cascade']);
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      if (bodyObj.cascade === true) {
        sendError(res, { status: 501, code: 'not_implemented', message: 'cascade cancel is not implemented in Phase 1', requestId, details: { paths: ['cascade'], available_in: 'Phase 2' }, headers: respHeaders });
        return;
      }
      await withIdempotency(false, async () => {
        const meta = getRunMeta(runId);
        if (!meta || !tokens.allowsProject(principal, meta.project_id)) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Run not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const reason = bodyObj.reason;
        if (typeof reason !== 'string' || reason.length < 1 || reason.length > 200) {
          return { status: 400, body: { error: { code: 'invalid_request', message: 'reason must be 1..200 chars', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const run = store.get(runId);
        const wasRunningOrWaiting = ['running', 'waiting'].includes(run.state);
        try {
          runtime.stop(runId, 'cancel', Date.now(), Boolean(bodyObj.preserve_wip ?? false), reason);
        } catch (err) {
          if (err instanceof InvalidState) {
            return {
              status: 409,
              body: {
                error: {
                  code: 'invalid_state',
                  message: `Run in state ${run.state} cannot be cancelled (${err.phase})`,
                  retryable: false,
                  retry_after_s: null,
                  request_id: requestId,
                  details: { state: run.state, phase: err.phase, allowed: allowedOpsForState(run.state) },
                },
              },
            };
          }
          throw err;
        }
        const updated = store.get(runId);
        return {
          status: wasRunningOrWaiting ? 202 : 200,
          body: serializeRun(updated, meta, getReleaseState(store, runId)),
        };
      });
      return;
    }

    // O-15: POST /v0/runs/:id/pause
    const runPauseMatch = /^\/v0\/runs\/([^/]+)\/pause$/.exec(path);
    if (method === 'POST' && runPauseMatch) {
      if (!requireScope('control')) return;
      const runId = runPauseMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['reason']);
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      await withIdempotency(false, async () => {
        const meta = getRunMeta(runId);
        if (!meta || !tokens.allowsProject(principal, meta.project_id)) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Run not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const reason = bodyObj.reason;
        if (typeof reason !== 'string' || reason.length < 1 || reason.length > 200) {
          return { status: 400, body: { error: { code: 'invalid_request', message: 'reason must be 1..200 chars', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const run = store.get(runId);
        const wasRunningOrWaiting = ['running', 'waiting'].includes(run.state);
        try {
          runtime.stop(runId, 'pause', Date.now(), true, reason);
        } catch (err) {
          if (err instanceof InvalidState) {
            return {
              status: 409,
              body: {
                error: {
                  code: 'invalid_state',
                  message: `Run in state ${run.state} cannot be paused (${err.phase})`,
                  retryable: false,
                  retry_after_s: null,
                  request_id: requestId,
                  details: { state: run.state, phase: err.phase, allowed: allowedOpsForState(run.state) },
                },
              },
            };
          }
          throw err;
        }
        const updated = store.get(runId);
        return {
          status: wasRunningOrWaiting ? 202 : 200,
          body: serializeRun(updated, meta, getReleaseState(store, runId)),
        };
      });
      return;
    }

    // O-18: POST /v0/runs/:id/messages
    const runMsgMatch = /^\/v0\/runs\/([^/]+)\/messages$/.exec(path);
    if (method === 'POST' && runMsgMatch) {
      if (!requireScope('control')) return;
      const runId = runMsgMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['text', 'kind']);
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      await withIdempotency(true, async () => {
        const meta = getRunMeta(runId);
        if (!meta || !tokens.allowsProject(principal, meta.project_id)) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Run not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const text = bodyObj.text;
        const kind = bodyObj.kind ?? 'answer';
        if (typeof text !== 'string' || text.length < 1 || Buffer.byteLength(text) > 64 * 1024 || !['answer', 'instruction'].includes(String(kind))) {
          return { status: 400, body: { error: { code: 'invalid_request', message: 'Invalid message text or kind', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const run = store.get(runId);
        if (run.messages.some(m => m.state === 'pending')) {
          return {
            status: 409,
            body: {
              error: {
                code: 'invalid_state',
                message: 'Run already has a pending message',
                retryable: false,
                retry_after_s: null,
                request_id: requestId,
                details: { state: run.state, reason: 'message_pending' },
              },
            },
          };
        }
        const messageId = `msg_${randomUUID()}`;
        try {
          runtime.message(runId, messageId, text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (msg === 'invalid_message_state') {
            return {
              status: 409,
              body: {
                error: {
                  code: 'invalid_state',
                  message: `Run in state ${run.state} cannot accept messages`,
                  retryable: false,
                  retry_after_s: null,
                  request_id: requestId,
                  details: { state: run.state, allowed: allowedOpsForState(run.state) },
                },
              },
            };
          }
          throw err;
        }
        return {
          status: 202,
          body: { message_id: messageId, accepted_at: new Date().toISOString(), delivery: 'pending' },
        };
      });
      return;
    }

    // O-19: POST /v0/runs/:id/complete
    const runCompleteMatch = /^\/v0\/runs\/([^/]+)\/complete$/.exec(path);
    if (method === 'POST' && runCompleteMatch) {
      if (!requireScope('control')) return;
      const runId = runCompleteMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['note']);
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      await withIdempotency(false, async () => {
        const meta = getRunMeta(runId);
        if (!meta || !tokens.allowsProject(principal, meta.project_id)) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Run not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const run = store.get(runId);
        try {
          runtime.complete(runId);
        } catch (err) {
          if (err instanceof Error && err.message === 'invalid_complete_state') {
            return {
              status: 409,
              body: {
                error: {
                  code: 'invalid_state',
                  message: `Run in state ${run.state} cannot be completed`,
                  retryable: false,
                  retry_after_s: null,
                  request_id: requestId,
                  details: { state: run.state, allowed: allowedOpsForState(run.state) },
                },
              },
            };
          }
          throw err;
        }
        const updated = store.get(runId);
        return { status: 202, body: serializeRun(updated, meta, getReleaseState(store, runId)) };
      });
      return;
    }

    // O-16: POST /v0/runs/:id/continue
    const runContinueMatch = /^\/v0\/runs\/([^/]+)\/continue$/.exec(path);
    if (method === 'POST' && runContinueMatch) {
      if (!requireScope('submit')) return;
      const runId = runContinueMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['mode', 'verdicts', 'ruling_id', 'notes', 'overrides', 'rehome_dependents', 'source_version']);
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }
      if (bodyObj.verdicts !== undefined || bodyObj.ruling_id !== undefined) {
        const paths: string[] = [];
        if (bodyObj.verdicts !== undefined) paths.push('verdicts');
        if (bodyObj.ruling_id !== undefined) paths.push('ruling_id');
        sendError(res, { status: 501, code: 'not_implemented', message: 'verdicts/ruling_id on continue is not implemented in Phase 1', requestId, details: { paths, available_in: 'Phase 4' }, headers: respHeaders });
        return;
      }

      await withIdempotency(true, async scope => {
        const meta = getRunMeta(runId);
        if (!meta || !tokens.allowsProject(principal, meta.project_id)) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Run not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const taskRow = getTaskRow(meta.task_id);
        const task = JSON.parse(taskRow!.payload) as TaskRecord;
        if (task.state !== 'open') {
          return { status: 409, body: { error: { code: 'invalid_state', message: `Task is ${task.state}`, retryable: false, retry_after_s: null, request_id: requestId, details: { task_state: task.state } } } };
        }
        const source = store.get(runId);
        const mode = bodyObj.mode;
        if (!['resume', 'takeover', 'rework'].includes(String(mode))) {
          return { status: 400, body: { error: { code: 'invalid_request', message: 'mode must be resume, takeover, or rework', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const allowedModes: Record<string, string[]> = {
          paused: ['resume'],
          interrupted: ['takeover', 'rework'],
          failed: ['rework', 'takeover'],
          done: ['rework'],
        };
        if (!(allowedModes[source.state] ?? []).includes(String(mode))) {
          return { status: 409, body: { error: { code: 'invalid_state', message: `Cannot continue (${String(mode)}) run in state ${source.state}`, retryable: false, retry_after_s: null, request_id: requestId, details: { state: source.state, allowed: allowedOpsForState(source.state) } } } };
        }
        if ((mode === 'resume' || mode === 'takeover') && source.preservation.state === 'failed') {
          return { status: 409, body: { error: { code: 'preservation_failed', message: 'Source run preservation failed; cannot resume or takeover', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        if (bodyObj.source_version !== undefined && bodyObj.source_version !== source.version) {
          return { status: 409, body: { error: { code: 'version_conflict', message: 'Source run version mismatch', retryable: true, retry_after_s: null, request_id: requestId } } };
        }

        const project = projectMap.get(meta.project_id)!;
        const overrides = (bodyObj.overrides as Record<string, unknown> | undefined) ?? {};
        const newSpec: Record<string, unknown> = {
          role: meta.role,
          title: meta.title,
          instructions: meta.instructions + (typeof overrides.instructions_append === 'string' ? `\n\n${overrides.instructions_append}` : ''),
          runner: overrides.runner ?? meta.placement.runner,
          account: overrides.account !== undefined ? overrides.account : meta.placement.account_requested,
          model: overrides.model ?? meta.model_record.requested,
          reasoning_effort: overrides.reasoning_effort ?? meta.effort_record.requested,
          tier_rationale: overrides.tier_rationale ?? meta.tier_rationale,
          interaction: overrides.interaction ?? meta.interaction,
          workspace: meta.workspace_mode,
          read_only: meta.policy.read_only,
          degrade: overrides.degrade ?? meta.placement.degrade,
        };
        const check = validateRunSpec({ spec: newSpec, pathPrefix: 'overrides', taskLevel: task.level, project, runners: config.runners });
        if (check.violations.length > 0) {
          return { status: 422, body: { error: { code: 'validation_failed', message: 'Validation failed on continue', retryable: false, retry_after_s: null, request_id: requestId, violations: check.violations } } };
        }

        const now = Date.now();
        const newRunId = ulid('run', now);
        const baseSha = source.preservation.sha ?? source.workspaceHead ?? meta.base.sha;
        const isFork = meta.continued_by.length > 0;
        const lineage: RunMetadata['lineage'] = isFork
          ? { branch_id: newRunId, forked_from: source.id, candidate: null, version: 1 }
          : (meta.lineage ? { ...meta.lineage } : { branch_id: source.id, forked_from: null, candidate: null, version: 1 });

        const built = buildRunFromSpec({
          runId: newRunId,
          taskId: task.id,
          project,
          spec: newSpec,
          principal,
          now,
          continues: { run_id: source.id, mode: String(mode), sha: baseSha },
          lineage,
        });

        meta.continued_by.push(newRunId);
        task.run_ids.push(newRunId);
        task.version++;

        const serializedNew = serializeRun(built.run, built.meta, null);
        const respPayload = {
          run: serializedNew,
          source: { id: source.id, state: mode === 'resume' ? 'interrupted' : source.state, version: mode === 'resume' ? source.version + 1 : source.version },
          rehome: { rehomed: [], skipped: [] },
          warnings: check.warnings,
        };
        const respStr = JSON.stringify(respPayload);

        store.transaction(() => {
          if (mode === 'resume') {
            const from = source.state;
            move(source, 'interrupted', 'superseded', 'T18', now);
            store.put(source);
            stateEvent(store, source, from, now);
          }
          store.db.prepare('UPDATE api_runs SET payload=? WHERE id=?').run(JSON.stringify(meta), source.id);
          store.db.prepare('UPDATE api_tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
          store.put(built.run);
          store.db
            .prepare('INSERT INTO api_runs(id, task_id, project_id, client_ref, spec_fingerprint, payload, created_at) VALUES (?,?,?,?,?,?,?)')
            .run(built.run.id, task.id, project.id, null, sha256Hex(canonicalJson(newSpec)), JSON.stringify(built.meta), now);
          store.emit('run.created', { run: serializedNew, version: built.run.version }, built.run, now);
          stateEvent(store, built.run, null, now);
          idempotency.completeInTransaction(scope, 201, respStr, now);
        });

        return { status: 201, body: respStr, alreadyCommittedInTx: true };
      });
      return;
    }

    // O-21: POST /v0/runs/:id/release-worktree
    const runReleaseMatch = /^\/v0\/runs\/([^/]+)\/release-worktree$/.exec(path);
    if (method === 'POST' && runReleaseMatch) {
      if (!requireScope('decide')) return;
      const runId = runReleaseMatch[1]!;
      const unknown = findUnknownFields(bodyObj, ['preservation', 'note']);
      if (bodyObj.preservation && typeof bodyObj.preservation === 'object' && !Array.isArray(bodyObj.preservation)) {
        unknown.push(...findUnknownFields(bodyObj.preservation, ['kind', 'ref', 'ack'], 'preservation'));
      }
      if (unknown.length > 0) {
        sendError(res, { status: 400, code: 'invalid_request', message: 'Unknown fields', requestId, details: { unknown_fields: unknown }, headers: respHeaders });
        return;
      }

      await withIdempotency(false, async scope => {
        const meta = getRunMeta(runId);
        if (!meta || !tokens.allowsProject(principal, meta.project_id)) {
          return { status: 404, body: { error: { code: 'not_found', message: 'Run not found', retryable: false, retry_after_s: null, request_id: requestId } } };
        }
        const run = store.get(runId);
        if (!isTerminal(run.state)) {
          return {
            status: 409,
            body: {
              error: {
                code: 'invalid_state',
                message: `Run in state ${run.state} cannot release worktree`,
                retryable: false,
                retry_after_s: null,
                request_id: requestId,
                details: { state: run.state, allowed: allowedOpsForState(run.state) },
              },
            },
          };
        }
        const existingRelease = getReleaseState(store, runId);
        if (existingRelease && (existingRelease.state === 'pending' || existingRelease.state === 'completed')) {
          return {
            status: 409,
            body: {
              error: {
                code: 'invalid_state',
                message: 'Worktree already released or release pending',
                retryable: false,
                retry_after_s: null,
                request_id: requestId,
                details: { state: run.state, reason: 'already_released' },
              },
            },
          };
        }
        const preservation = bodyObj.preservation;
        if (!preservation || typeof preservation !== 'object' || Array.isArray(preservation)) {
          return { status: 400, body: { error: { code: 'invalid_request', message: 'preservation object is required', retryable: false, retry_after_s: null, request_id: requestId } } };
        }

        const project = projectMap.get(meta.project_id)!;
        const verified = verifyWorktreePreservation({
          repoRoot: resolve(project.workspace_path),
          run,
          runBranch: meta.branch,
          runBranchPrefix,
          preservation: preservation as Record<string, unknown>,
        });
        if (!verified.ok) {
          return {
            status: 422,
            body: {
              error: {
                code: 'preservation_unverified',
                message: verified.message,
                retryable: false,
                retry_after_s: null,
                request_id: requestId,
                details: { reason: verified.reason },
              },
            },
          };
        }

        const now = Date.now();
        const pendingRelease = {
          state: 'pending' as const,
          requested_at: new Date(now).toISOString(),
          released_at: null,
          error: null,
        };
        const respStr = JSON.stringify({ release: pendingRelease, verified: verified.verified });
        store.transaction(() => {
          saveReleaseState(store, run.id, pendingRelease, now);
          idempotency.completeInTransaction(scope, 200, respStr, now);
        });

        await executeWorktreeRelease({
          store,
          repoRoot: resolve(project.workspace_path),
          run,
          verified: verified.verified,
        });

        return { status: 200, body: respStr, alreadyCommittedInTx: true };
      });
      return;
    }

    sendError(res, { status: 404, code: 'not_found', message: `Route ${method} ${path} not found`, requestId, headers: respHeaders });
  };

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res).catch(err => {
      if (!res.headersSent) {
        sendError(res, {
          status: 500,
          code: 'internal',
          message: err instanceof Error ? err.message : 'Internal server error',
          retryable: true,
          requestId: ulid('req'),
        });
      } else {
        res.end();
      }
    });
  });

  return {
    server,
    listen(port = config.port ?? 0, host = config.host ?? '127.0.0.1') {
      return new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(port, host, () => {
          server.removeListener('error', rejectPromise);
          const addr = server.address();
          if (!addr || typeof addr === 'string') {
            rejectPromise(new Error('Unexpected server address'));
            return;
          }
          resolvePromise({ port: addr.port, host: addr.address, url: `http://${addr.address}:${addr.port}` });
        });
      });
    },
    close() {
      return new Promise((resolvePromise, rejectPromise) => {
        server.closeAllConnections();
        server.close(err => (err ? rejectPromise(err) : resolvePromise()));
      });
    },
  };
}
