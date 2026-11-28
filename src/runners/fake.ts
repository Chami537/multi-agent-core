import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { emptyUsage, type Finished, type StartParams } from '../core/types.js';
import { scenario, type Scenario } from './scenarios.js';

const unsupportedFlag = process.argv.slice(2).find(a => !['--resume','--mac-runner'].includes(a));
if (unsupportedFlag) { process.stderr.write(`not_implemented: ${unsupportedFlag}\n`); process.exit(64); }
const runner = { id: 'fake', name: 'Fake Runner', impl_version: '0.1.0', native_version: null };
const mode = process.argv.includes('--resume') ? 'resume' : 'stdin';
let initialized = false, started = false, finished = false, waiting = false, ignoreTerm = false;
let seq = 0, steps = 0, turns = 0, workStarted = false, inputResolve: (() => void) | null = null;
let params: StartParams, script: Scenario, usage = emptyUsage();
const inputs = new Map<string, string>();
function send(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function event(type: string, data: unknown): void { if (!finished) send({ jsonrpc: '2.0', method: 'event', params: { seq: ++seq, ts: new Date().toISOString(), type, data } }); }
function reportModel(): Record<string, unknown> {
  const effective = script.model_effective === undefined ? params.model.id : script.model_effective;
  return { requested: params.model.id, effective, effective_source: effective === null ? 'unknown' : 'native_reported', auxiliary: [], evidence: effective === null ? null : 'fake_scenario' };
}
function reportEffort(): Record<string, unknown> {
  if (process.env.MAC_FAKE_EFFORT_REPORTING === 'none') {
    return { requested: params.reasoning_effort.effort, requested_native: params.reasoning_effort.native,
      effective: null, effective_native: null, effective_source: 'unknown' };
  }
  const effective = script.effort_effective === undefined ? (params.reasoning_effort.effort === 'default' ? 'high' : params.reasoning_effort.effort) : script.effort_effective;
  const mapping: Record<string, string> = { low: 'l', medium: 'm', high: 'h' };
  return { requested: params.reasoning_effort.effort, requested_native: params.reasoning_effort.native,
    effective, effective_native: effective === null ? null : mapping[effective] ?? null, effective_source: effective === null ? 'unknown' : 'native_reported' };
}
function finish(outcome: Finished['outcome'], error: Finished['error'] = null, message: string | null = null, token: string | null = null, nativeExit: { code: number | null; signal: string | null } = { code: 0, signal: null }): void {
  if (finished || !started) return;
  usage = { ...usage, steps, turns, completeness: 'exact' };
  const nativeSessionId = script?.native_session_id !== undefined ? script.native_session_id : `fake-${params.run_id}`;
  event('run.finished', { outcome, error, work_started: workStarted, final_message: message, usage, model: reportModel(), reasoning_effort: reportEffort(), steps, turns, resume_token: token, native_session_id: nativeSessionId, native_exit: nativeExit } satisfies Finished);
  finished = true; waiting = false; inputResolve?.();
}
function step(): boolean {
  if (params.limits.max_steps !== null && steps >= params.limits.max_steps) {
    finish('failed', { code: 'step_limit_reached', category: 'budget', retryable: false, scope: 'run', message: 'model invocation limit', evidence: { source: 'fake.step' } }); return false;
  }
  steps++; workStarted = true; usage = { ...usage, steps, turns, completeness: 'partial' }; event('usage', usage); return true;
}
async function execute(index = 0): Promise<void> {
  if (!script.steps.some(s => s.op === 'step') && !step()) return;
  for (let i = index; i < script.steps.length && !finished; i++) {
    const op = script.steps[i]!;
    switch (op.op) {
      case 'step': if (!step()) return; break;
      case 'message': event('message', { role: 'assistant', text: String(op.text ?? ''), final: !!op.final, truncated: false }); break;
      case 'reasoning': event('reasoning', { text: op.text ?? null, summary: true, redacted: false, truncated: false }); break;
      case 'tool': {
        const call = `call-${i}`; event('tool.call', { call_id: call, tool: op.tool, kind: op.kind ?? 'other', summary: op.summary ?? '', input: null });
        await delay(Number(op.duration_ms ?? 0));
        event('tool.result', { call_id: call, status: op.status ?? 'ok', summary: op.summary ?? null, output_excerpt: null, exit_code: op.exit_code ?? null, duration_ms: op.duration_ms ?? 0 }); break;
      }
      case 'usage':
        for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const) if (op[key] !== undefined) usage[key] = op[key] as number | null;
        usage.extra = op.extra as Record<string, unknown> ?? {}; usage.steps = steps; usage.turns = turns; usage.completeness = 'partial'; event('usage', usage); break;
      case 'sleep': await delay(Number(op.ms)); break;
      case 'await_input':
        turns++; event('turn.completed', { turn: turns, stop_reason: 'end_turn' });
        if (mode === 'resume') { finish('awaiting_input', null, null, Buffer.from(JSON.stringify({ script, index: i + 1, turns })).toString('base64url')); return; }
        waiting = true; event('input.requested', { turn: turns, prompt_excerpt: op.prompt ?? null });
        await new Promise<void>(resolve => { inputResolve = resolve; }); inputResolve = null; waiting = false; break;
      case 'fail': if (typeof op.work_started === 'boolean') workStarted = op.work_started; finish('failed', op.error as Finished['error'] ?? { code: 'task_failed' }); return;
      case 'complete': finish('completed', null, String(op.final_message ?? 'complete')); return;
      case 'ignore_sigterm': ignoreTerm = true; break;
      case 'spawn_child':
        spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{}); setTimeout(()=>{}, ${Number(op.sleep_ms ?? 60_000)})`], { stdio: 'ignore', env: {} }); break;
      case 'crash': process.exit(Number(op.exit_code ?? 1)); break;
      case 'native_crash': {
        const stub = process.env.MAC_FAKE_NATIVE_STUB;
        const exitCode = Number(op.exit_code ?? 42);
        const exit = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
          const child = stub
            ? spawn(process.execPath, [stub], { stdio: 'ignore', env: { ...process.env, MAC_NATIVE_EXIT_CODE: String(exitCode) } })
            : spawn(process.execPath, ['-e', `process.exit(${exitCode})`], { stdio: 'ignore', env: {} });
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        finish('failed', { code: 'runner_crash', category: 'runner', retryable: false, scope: 'run', message: 'native process crashed', evidence: { exit_code: exit.code, signal: exit.signal } }, null, null, exit);
        return;
      }
      case 'model_changed': {
        const nextModel = op.model_effective !== undefined ? (op.model_effective as string | null) : script.model_effective;
        if (nextModel !== undefined) script.model_effective = nextModel;
        const payload: Record<string, unknown> = {
          model: {
            requested: params.model.id,
            effective: nextModel ?? null,
            effective_source: nextModel === null || nextModel === undefined ? 'unknown' : 'native_reported',
            evidence: op.evidence ?? 'native_model_switch',
          },
          reason: op.reason ?? 'fallback',
        };
        if (op.effort_effective !== undefined) {
          script.effort_effective = op.effort_effective as string | null;
          payload.reasoning_effort = reportEffort();
        }
        event('model.changed', payload);
        break;
      }
      case 'emit_raw': process.stdout.write(`${String(op.line)}\n`); break;
      case 'hang': await new Promise<void>(() => {}); break;
      default: throw new Error(`not_implemented: scenario.${op.op}`);
    }
  }
  if (!finished) finish('completed');
}
class RpcError extends Error { constructor(readonly code: number, message: string, readonly data: unknown = null) { super(message); } }
function strict(value: Record<string, unknown>, keys: string[]): void {
  const unknown = Object.keys(value).filter(k => !keys.includes(k));
  if (unknown.length) throw new RpcError(-32602, 'unknown field', { unknown_fields: unknown });
}
function validate(p: Record<string, unknown>, partial = false): void {
  strict(p, ['run_id','segment','prompt','model','reasoning_effort','interaction','workspace','limits','forbidden','resume','raw_dir','conformance']);
  if (partial) p = { run_id: 'validation', segment: 1, raw_dir: null, conformance: null, ...p,
    workspace: { cwd: '/unused', artifacts_dir: '/unused', scratch_dir: '/unused', readonly_paths: [], ...(p.workspace as object) } };
  const s = p as unknown as StartParams;
  if (typeof s.run_id !== 'string' || !Number.isSafeInteger(s.segment) || s.segment < 1 || !s.prompt || !s.workspace || !s.model || !s.reasoning_effort || !s.limits || !Array.isArray(s.forbidden)) throw new RpcError(-32602, 'invalid start');
  strict(s.prompt, ['text', 'format']); strict(s.model, ['id']); strict(s.reasoning_effort, ['effort', 'native']);
  strict(s.workspace, ['cwd', 'read_only', 'artifacts_dir', 'scratch_dir', 'readonly_paths']); strict(s.limits, ['max_steps', 'total_s', 'idle_s']);
  if (s.prompt.format !== 'markdown' || typeof s.prompt.text !== 'string' || Buffer.byteLength(s.prompt.text) > 900 * 1024 || s.raw_dir !== null) throw new RpcError(-32602, 'invalid start fields');
  if (!['autonomous', 'interactive'].includes(s.interaction)) throw new RpcError(-32602, 'invalid interaction');
  if (s.workspace.read_only) reject('READ_ONLY_UNSUPPORTED', 'workspace.read_only');
  if (s.forbidden.length) reject('FORBIDDEN_UNSUPPORTED', 'forbidden');
  if (s.model.id !== 'fake-high') reject('MODEL_UNKNOWN', 'model.id');
  if (!['default','low','medium','high'].includes(s.reasoning_effort.effort)) reject('EFFORT_UNSUPPORTED', 'reasoning_effort.effort');
  const mapped: Record<string, string | null> = { default: null, low: 'l', medium: 'm', high: 'h' };
  if (s.reasoning_effort.native !== mapped[s.reasoning_effort.effort]) reject('EFFORT_UNSUPPORTED', 'reasoning_effort.native');
  if (s.limits.max_steps !== null && (!Number.isSafeInteger(s.limits.max_steps) || s.limits.max_steps < 0)) throw new RpcError(-32602, 'invalid max_steps');
  if (s.resume && mode !== 'resume') reject('RESUME_UNSUPPORTED', 'resume');
  if (s.resume) {
    strict(s.resume, ['token','input','usage_baseline']); strict(s.resume.input, ['input_id','text']);
    if (s.resume.usage_baseline !== null && (typeof s.resume.usage_baseline !== 'object' || Array.isArray(s.resume.usage_baseline))) throw new RpcError(-32602, 'invalid usage_baseline');
  }
  if (s.conformance) strict(s.conformance, ['scenario']);
  if (s.conformance && process.env.MAC_CONFORMANCE !== '1') throw new RpcError(-32006, 'conformance mode disabled');
}
function reject(rule: string, path: string): never { throw new RpcError(-32005, 'rejected', { violations: [{ rule, path, message: rule }] }); }
function capabilities(): unknown {
  return { runner, account: { id: process.env.MAC_ACCOUNT_ID ?? 'fake', status: 'configured' },
    features: { read_only: { enforceable: false, mechanism: null }, usage: { streaming: true, final_receipt: 'exact', fields: ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'], native_cost: false },
      cancel: { control_message: true, grace_s: 10 }, interaction: { modes: ['autonomous', 'interactive'], input: mode, holds_slot_while_waiting: mode === 'stdin', mid_turn_input: false },
      model_reporting: 'session', effort_reporting: process.env.MAC_FAKE_EFFORT_REPORTING === 'none' ? 'none' : 'session', limits: { max_steps: true }, forbidden_enforcement: [], raw_capture: false, events: { reasoning: true, file_changes: false } },
    models: [{ id: 'fake-high', tier: 'high', aliases: [], efforts: [{ effort: 'low', native: 'l' }, { effort: 'medium', native: 'm' }, { effort: 'high', native: 'h' }], default_effort: 'high', availability: 'assumed', verified_at: null }],
    catalog: { source: 'static', fetched_at: null, note: 'D1 subset' }, probe: { levels: ['auth'], components: ['auth'] },
    conformance: { native_override: true, scenarios: true }, extensions: [] };
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (finished) return; // run.finished is the final protocol message.
  let id: unknown = null;
  try {
    if (Buffer.byteLength(line) > 1_048_576) throw new RpcError(-32600, 'line too large');
    const request = JSON.parse(line) as { jsonrpc: string; id: unknown; method: string; params?: Record<string, unknown> };
    id = request.id;
    if (request.jsonrpc !== '2.0' || id === undefined) throw new RpcError(-32600, 'invalid request');
    const p = request.params ?? {};
    let result: unknown = {};
    if (request.method === 'initialize') {
      if (initialized) throw new RpcError(-32003, 'already initialized');
      strict(p, ['protocol_versions','host','session_kind','conformance']);
      if (!Array.isArray(p.protocol_versions) || !p.protocol_versions.includes('0.2')) {
        send({ jsonrpc: '2.0', id, error: { code: -32001, message: 'version unsupported', data: { supported: ['0.2'] } } }); process.exitCode = 64; lines.close(); process.stdin.destroy(); return;
      }
      initialized = true; result = { protocol_version: '0.2', runner, extensions: [] };
    } else {
      if (!initialized) throw new RpcError(-32002, 'not initialized');
      switch (request.method) {
        case 'capabilities': strict(p, []); result = capabilities(); break;
        case 'validate':
          strict(p, ['start']);
          if (!p.start || typeof p.start !== 'object') throw new RpcError(-32602, 'missing start');
          try { validate(p.start as Record<string, unknown>, true); result = { ok: true, violations: [], warnings: [] }; }
          catch (e) { if (!(e instanceof RpcError) || e.code !== -32005) throw e; result = { ok: false, ...(e.data as object), warnings: [] }; }
          break;
        case 'probe':
          strict(p, ['level']);
          if (p.level !== 'auth') throw new RpcError(-32005, 'probe not implemented');
          result = process.env.MAC_FAKE_PROBE_STATUS === 'failed'
            ? { level: 'auth', status: 'failed', billable: false, components: [{ id: 'auth', status: 'failed', detail: 'synthetic auth failure', error: { code: 'auth_failed', category: 'auth', retryable: false, scope: 'account', message: 'synthetic auth failure' } }], observed: null, checked_at: new Date().toISOString() }
            : { level: 'auth', status: 'ok', billable: false, components: [{ id: 'auth', status: 'ok', detail: 'synthetic fake account', error: null }], observed: null, checked_at: new Date().toISOString() };
          break;
        case 'run.start': {
          if (started) throw new RpcError(-32003, 'already_started');
          validate(p); params = p as unknown as StartParams;
          const embedded = /```mac-fake\s*\n([\s\S]*?)```/.exec(params.prompt.text)?.[1]?.trim();
          script = scenario(params.conformance?.scenario ?? (embedded ? (embedded.startsWith('{') ? JSON.parse(embedded) : embedded) : 'ok'));
          let index = 0;
          if (params.resume) {
            if (mode !== 'resume') throw new RpcError(-32005, 'resume unsupported');
            const saved = JSON.parse(Buffer.from(params.resume.token, 'base64url').toString('utf8')) as { script: Scenario; index: number; turns: number };
            if (!params.conformance?.scenario) {
              script = scenario(saved.script);
            }
            index = saved.index; turns = saved.turns;
          }
          const nativeSessionId = script.native_session_id !== undefined ? script.native_session_id : `fake-${params.run_id}`;
          started = true; send({ jsonrpc: '2.0', id, result: { accepted: true, native_session_id: nativeSessionId } });
          event('session.started', { native_session_id: nativeSessionId, native_version: null, model: reportModel(), reasoning_effort: reportEffort() });
          void execute(index).catch(error => finish('failed', { code: 'runner_internal', message: String(error) })); return;
        }
        case 'run.input': {
          strict(p, ['input_id', 'text']);
          if (typeof p.input_id !== 'string' || typeof p.text !== 'string') throw new RpcError(-32602, 'invalid input');
          if (inputs.has(p.input_id)) { if (inputs.get(p.input_id) !== p.text) throw new RpcError(-32007, 'input_conflict'); result = { accepted: true, duplicate: true }; break; }
          if (!waiting) throw new RpcError(-32004, 'not waiting');
          inputs.set(p.input_id, p.text); result = { accepted: true, duplicate: false };
          send({ jsonrpc: '2.0', id, result }); inputResolve?.(); return;
        }
        case 'run.complete': strict(p, []); if (!waiting) throw new RpcError(-32004, 'not waiting'); send({ jsonrpc: '2.0', id, result: { accepted: true } }); finish('completed'); return;
        case 'run.cancel': strict(p, ['reason', 'grace_s']); send({ jsonrpc: '2.0', id, result: { accepted: true } }); finish('cancelled'); return;
        default: throw new RpcError(-32601, 'not_implemented');
      }
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    const error = e instanceof RpcError ? e : new RpcError(e instanceof SyntaxError ? -32700 : -32602, String(e));
    send({ jsonrpc: '2.0', id, error: { code: error.code, message: error.message, data: error.data } });
  }
});
lines.on('close', () => { if (!finished && started) finish('cancelled'); if (!started && process.exitCode === 64) return; process.exit(0); });
process.on('SIGTERM', () => { if (!ignoreTerm) { finish('cancelled'); process.exit(0); } });
process.stdout.on('error', () => process.exit(0));
