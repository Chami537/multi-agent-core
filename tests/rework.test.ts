import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Runtime } from '../dist/core/runtime.js';
import { move, recordCandidate } from '../dist/core/lifecycle.js';
import { emptyUsage, type Finished, type Run } from '../dist/core/types.js';
import { alive, bootId, durableJson, signalGroup } from '../dist/host/process.js';
import { allocations, cleanup, launchFixture, makeRuntime, markerPreserver, prompt, state, until, workspace } from './helpers/runtime.js';

afterEach(cleanup);
const script = (steps: unknown[]) => prompt({ schema: 'mac.fake-scenario/0.2', steps });
function receipt(outcome: Finished['outcome'] = 'completed'): Finished {
  return { outcome, error: outcome === 'failed' ? { code: 'task_failed' } : null, work_started: true, final_message: null, usage: emptyUsage(), model: {}, reasoning_effort: {}, steps: 1, turns: 1, resume_token: null, native_session_id: null, native_exit: null };
}
function reopen(rt: Runtime, boot = bootId()): Runtime {
  rt.close(); const next = new Runtime({ root: rt.root, preserve: markerPreserver, boot, timing: { exitMs: 120, killMs: 70, graceMs: 70 } });
  allocations.push({ root: rt.root, runtime: next }); return next;
}
async function resident(rt: Runtime): Promise<Run> {
  const r = rt.create({ workspace: workspace(rt), prompt: script([{ op: 'step' }, { op: 'hang' }]) });
  rt.start(r.id); await until(async () => { await rt.tick(); return rt.store.get(r.id).usage.steps === 1; }); return r;
}
function stopEvents(rt: Runtime, id: string) { return rt.store.eventsSince(0, 1000).events.filter(e => e.run_id === id && e.type === 'run.stop_requested'); }

describe('D1 required regressions', () => {
  it('stdin waiting crash interrupts with WIP and releases the slot', async () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), inputMode: 'stdin', prompt: prompt('interactive:1') });
    rt.start(r.id); await state(rt, r.id, 'waiting'); rt.host.signal(r.runDir, 1, 'SIGKILL');
    const ended = await state(rt, r.id, 'interrupted');
    expect(ended.reason).toBe('runner_crash'); expect(ended.preservation.kind).toBe('wip'); expect(ended.preservation.state).toBe('saved'); expect(ended.reservation).toBe(false);
    const other = rt.create({ workspace: workspace(rt) }); rt.start(other.id); await state(rt, other.id, 'done');
  });
  it.each(['step_limit_reached', 'supervisor_pause'])('cancel commits T19 immediately from paused by %s', async source => {
    const rt = makeRuntime(), r = source === 'supervisor_pause' ? await resident(rt) : rt.create({ workspace: workspace(rt), fakeMaxSteps: 1, prompt: prompt('steps_limit') });
    if (source === 'supervisor_pause') rt.stop(r.id, 'pause'); else rt.start(r.id);
    const paused = await state(rt, r.id, 'paused'); expect(paused.reason).toBe(source); expect(paused.finalizing).toBe(false);
    rt.stop(r.id); const cancelled = rt.store.get(r.id);
    expect(cancelled.state).toBe('cancelled'); expect(cancelled.finalizing).toBe(false); expect(cancelled.reservation).toBe(false);
    expect(cancelled.version).toBeGreaterThan(paused.version); expect(stopEvents(rt, r.id).at(-1)?.data.stop_request).toMatchObject({ kind: 'cancel', preserveWip: false });
    expect(rt.store.eventsSince(0, 1000).events.some(e => e.type === 'run.state_changed' && e.run_id === r.id && e.data.from === 'paused' && e.data.to === 'cancelled')).toBe(true);
  });
  it('cancel of an unstarted run is committed without tick or preservation', () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt) }); rt.stop(r.id);
    expect(rt.store.get(r.id)).toMatchObject({ state: 'cancelled', finalizing: false, preservation: { state: 'not_required' } });
  });
  it('default cancel of processless resume waiting commits T19 in the stop transaction', async () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), inputMode: 'resume', prompt: prompt('interactive:1') });
    rt.start(r.id); await state(rt, r.id, 'waiting'); rt.stop(r.id);
    expect(rt.store.get(r.id)).toMatchObject({ state: 'cancelled', finalizing: false, preservation: { state: 'not_required' } });
  });
  it('resume receipts survive daemon reopen and aggregate 100 + 7 without double counting', async () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), inputMode: 'resume', fakeMaxSteps: 4, prompt: script([
      { op: 'step' }, { op: 'usage', input_tokens: 100, output_tokens: 10, cache_read_tokens: 1, cache_write_tokens: 0 }, { op: 'await_input' },
      { op: 'step' }, { op: 'usage', input_tokens: 7, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 }, { op: 'complete' },
    ]) });
    rt.start(r.id); const first = await state(rt, r.id, 'waiting'); const next = reopen(rt); await next.recover();
    next.message(r.id, 'next', 'go'); next.start(r.id); const done = await state(next, r.id, 'done');
    expect(done.previousSteps).toBe(1); expect(done.segmentUsage['1']).toEqual(first.segmentUsage['1']);
    expect(done.segmentUsage['2']?.input_tokens).toBe(7); expect(done.usage).toMatchObject({ input_tokens: 107, output_tokens: 12, steps: 2, completeness: 'exact' });
    await next.tick(); expect(next.store.get(r.id).usage).toEqual(done.usage);
  });
  it.each(['stderr-large', 'raw-large'])('%s cannot truncate the protocol stream', async mode => {
    const rt = makeRuntime(), r = launchFixture(rt, mode); const done = await state(rt, r.id, 'done');
    expect(done.protocolViolation).toBeNull(); expect(rt.host.status(r.runDir, 1)?.error).toBeNull();
    const dir = rt.host.directory(r.runDir, 1), log = readFileSync(join(dir, mode === 'stderr-large' ? 'stderr.log' : 'raw.log'), 'utf8');
    expect(log).toContain('[mac: oversized log line truncated]'); expect(log.length).toBeGreaterThan(1_048_576);
    expect(readFileSync(join(dir, 'protocol.ndjson'), 'utf8')).toContain('after large log');
  });
  it('oversized stdout still becomes a protocol violation', async () => {
    const rt = makeRuntime(), r = launchFixture(rt, 'stdout-large');
    expect((await state(rt, r.id, 'failed')).reason).toBe('protocol_violation');
    expect(rt.host.status(r.runDir, 1)?.error).toBe('line_too_large');
  });
  it('complete outbox and finalizing survive a delivery crash and daemon reopen', async () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), inputMode: 'stdin', prompt: prompt('interactive:2') });
    rt.start(r.id); await state(rt, r.id, 'waiting'); rt.host.command = () => { throw new Error('delivery crash'); };
    expect(() => rt.complete(r.id)).toThrow('delivery crash'); expect(rt.store.get(r.id).finalizing).toBe(true);
    const next = reopen(rt); expect(() => next.message(r.id, 'late', 'go')).toThrow('invalid_message_state'); expect(() => next.complete(r.id)).toThrow('invalid_complete_state');
    await next.recover(); expect((await state(next, r.id, 'done')).messages).toHaveLength(0);
  });
  it('complete rolls back finalizing and version if the outbox transaction fails', async () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), inputMode: 'stdin', prompt: prompt('interactive:2') });
    rt.start(r.id); const before = await state(rt, r.id, 'waiting');
    rt.store.db.exec("CREATE TRIGGER reject_complete BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT, 'outbox failure'); END");
    expect(() => rt.complete(r.id)).toThrow('outbox failure'); expect(rt.store.get(r.id).finalizing).toBe(false); expect(rt.store.get(r.id).version).toBe(before.version);
  });
  it.each([false, true])('running cancel preserves WIP only with explicit preserveWip=%s', async preserve => {
    const rt = makeRuntime(), r = await resident(rt); if (preserve) rt.stop(r.id, 'cancel', Date.now(), true); else rt.stop(r.id);
    const done = await state(rt, r.id, 'cancelled'); expect(done.preservation.state).toBe(preserve ? 'saved' : 'not_required');
    expect(existsSync(join(r.runDir, 'wip-marker.json'))).toBe(preserve); expect(existsSync(join(r.runDir, 'final-marker.json'))).toBe(false);
  });
  it.each(['pause', 'budget', 'guard', 'timeout'] as const)('%s always preserves WIP even with preserveWip=false', async kind => {
    const rt = makeRuntime(), r = await resident(rt); rt.stop(r.id, kind, Date.now(), false);
    const done = await state(rt, r.id, kind === 'timeout' ? 'interrupted' : 'paused'); expect(done.preservation).toMatchObject({ state: 'saved', kind: 'wip' }); expect(done.stop?.preserveWip).toBe(true);
  });
  it.each(['pause', 'budget', 'guard', 'timeout', 'cancel', 'completed'] as const)('preservation failure for %s is explicit and protected', async kind => {
    const rt = makeRuntime({ preserve: async (_r, k) => ({ state: 'failed', kind: k, error: 'disk full', sha: null }) });
    const r = kind === 'completed' ? rt.create({ workspace: workspace(rt) }) : await resident(rt);
    if (kind === 'completed') rt.start(r.id); else rt.stop(r.id, kind, Date.now(), true);
    const done = await state(rt, r.id, kind === 'completed' ? 'failed' : kind === 'cancel' ? 'cancelled' : 'interrupted');
    expect(done.reason).toBe('preservation_failed'); expect(done.protected).toBe(true); expect(done.preservation.kind).toBe(kind === 'completed' ? 'final' : 'wip');
    expect(rt.store.eventsSince(0, 1000).events.some(e => e.run_id === r.id && e.type === 'alert' && e.data.kind === 'preservation_failed')).toBe(true);
  });
  it('host restart preserves processless resume waiting and its usable token', async () => {
    const rt = makeRuntime({ boot: 'old-boot' }), r = rt.create({ workspace: workspace(rt), inputMode: 'resume', prompt: prompt('interactive:1') });
    rt.start(r.id); const waiting = await state(rt, r.id, 'waiting'); const next = reopen(rt); await next.recover();
    expect(next.store.get(r.id)).toEqual(waiting); next.message(r.id, 'after-reboot', 'go'); next.start(r.id);
    expect((await state(next, r.id, 'done')).segment).toBe(2);
  });
  it('records current non-environment failed preservation kind (S3 explicitly deferred)', async () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), prompt: prompt('fail') }); rt.start(r.id);
    const failed = await state(rt, r.id, 'failed'); expect(failed.reason).toBe('task_failed'); expect(failed.preservation).toMatchObject({ state: 'saved', kind: 'wip' });
  });
  it.each(['running', 'waiting'] as const)('host restart interrupts a resident %s run, preserves WIP and emits an alert', async before => {
    const rt = makeRuntime({ boot: 'old-boot' }), r = rt.create({ workspace: workspace(rt), inputMode: 'stdin' });
    move(r, 'running', null); if (before === 'waiting') move(r, 'waiting', 'awaiting_input');
    rt.store.transaction(() => rt.store.put(r)); const next = reopen(rt); await next.recover();
    expect(next.store.get(r.id)).toMatchObject({ state: 'interrupted', reason: 'host_restart', preservation: { state: 'saved', kind: 'wip' }, reservation: false });
    expect(next.store.eventsSince(0, 1000).events.some(e => e.type === 'alert' && e.data.kind === 'host_restart')).toBe(true);
  });
  it.each(['candidate', 'cancel', 'pause'] as const)('host restart retains an already committed %s and its commit order', async first => {
    const rt = makeRuntime({ boot: 'old-boot' }), r = rt.create({ workspace: workspace(rt) }); r.segment = 1; move(r, 'running', null);
    rt.store.transaction(() => rt.store.put(r));
    if (first !== 'candidate') rt.stop(r.id, first);
    const current = rt.store.get(r.id); recordCandidate(current, receipt(), 10); rt.store.transaction(() => rt.store.put(current));
    const next = reopen(rt); await next.recover(); const ended = next.store.get(r.id);
    expect(ended.state).toBe(first === 'candidate' ? 'done' : first === 'cancel' ? 'cancelled' : 'paused');
    expect(ended.candidate?.at).toBe(10); expect(ended.candidate?.stopPrecedes).toBe(first !== 'candidate');
    expect(ended.preservation.kind).toBe(first === 'candidate' ? 'final' : first === 'cancel' ? null : 'wip');
  });
});

describe('supervisor additions', () => {
  it.each([false, true])('runner crash with descendants=%s stays interrupted(runner_crash)', async descendants => {
    const rt = makeRuntime(), r = descendants ? launchFixture(rt, 'crash-orphan') : rt.create({ workspace: workspace(rt), prompt: script([{ op: 'crash' }]) });
    if (!descendants) rt.start(r.id);
    const ended = await state(rt, r.id, 'interrupted'); expect(ended.reason).toBe('runner_crash'); expect(ended.protocolViolation).toBeNull(); expect(ended.preservation.kind).toBe('wip');
    expect(ended.candidate?.source).toBe('host'); expect(rt.host.facts(r.runDir, 1).groupAlive).toBe(false);
    if (descendants) expect(ended.cleanupTermAt).not.toBeNull();
  });
  it('budget backstop emits one versioned stop event before the final candidate, atomically with its cursor', async () => {
    const rt = makeRuntime(), r = launchFixture(rt, 'linger'); const configured = rt.store.get(r.id); configured.maxSteps = 0; rt.store.transaction(() => rt.store.put(configured));
    const done = await state(rt, r.id, 'paused'); expect(done.reason).toBe('budget_exceeded'); expect(done.candidate?.stopPrecedes).toBe(true);
    const events = stopEvents(rt, r.id); expect(events).toHaveLength(1); expect(events[0]?.data).toMatchObject({ version: expect.any(Number), stop_request: { kind: 'budget', preserveWip: true } });
    await rt.tick(); expect(stopEvents(rt, r.id)).toHaveLength(1);
  });
  it('control-message cancellation uses declared grace and records the actual shim send time', async () => {
    const rt = makeRuntime(), r = launchFixture(rt, 'control');
    await until(async () => { await rt.tick(); return rt.host.status(r.runDir, 1)?.cancel?.control_message === true; });
    rt.stop(r.id); const ended = await state(rt, r.id, 'cancelled');
    const sent = JSON.parse(readFileSync(join(r.workspace, 'cancel.json'), 'utf8')) as { params: unknown; at: number };
    expect(sent.params).toEqual({ reason: 'supervisor', grace_s: 1 }); expect(existsSync(join(r.workspace, 'term.json'))).toBe(false);
    expect(ended.stop?.sentAt).toBe(rt.host.status(r.runDir, 1)?.stopSentAt); expect(ended.stop?.sentAt).toBeGreaterThanOrEqual(ended.stop!.requestedAt);
    const rows = rt.store.db.prepare("SELECT payload FROM activity WHERE run_id=? AND json_extract(payload,'$.type')='mac.stop_sent'").all(r.id);
    expect(rows).toHaveLength(1);
  });
  it('SIGTERM fallback escalates at declared grace + kill, rather than injected grace', async () => {
    const rt = makeRuntime({ timing: { exitMs: 100, killMs: 80, graceMs: 1 } }), r = launchFixture(rt, 'no-control');
    await until(() => rt.host.status(r.runDir, 1)?.cancel?.control_message === false);
    rt.stop(r.id); await rt.tick(); const at = rt.store.get(r.id).stop!.sentAt!; const endpoint = rt.host.status(r.runDir, 1)!.endpoint!;
    await rt.tick(at + 1079); expect(alive(endpoint)).toBe(true); await rt.tick(at + 1080);
    expect((await state(rt, r.id, 'cancelled')).reason).toBe('supervisor_cancel'); expect(alive(endpoint)).toBe(false);
  });
  it('unanswered run.cancel escalates from its actual write time with declared grace', async () => {
    const rt = makeRuntime({ timing: { exitMs: 100, killMs: 80, graceMs: 1 } }), r = launchFixture(rt, 'control-hang');
    await until(() => rt.host.status(r.runDir, 1)?.cancel?.control_message === true); rt.stop(r.id);
    await until(async () => { await rt.tick(); return rt.store.get(r.id).stop?.sentAt != null; });
    const at = rt.store.get(r.id).stop!.sentAt!, endpoint = rt.host.status(r.runDir, 1)!.endpoint!;
    await rt.tick(at + 1079); expect(alive(endpoint)).toBe(true); await rt.tick(at + 1080);
    expect((await state(rt, r.id, 'cancelled')).reason).toBe('supervisor_cancel'); expect(alive(endpoint)).toBe(false);
  });
  it('a stale group leader start time or boot cannot signal a live unrelated group', async () => {
    const rt = makeRuntime(), r = launchFixture(rt, 'no-control');
    await until(() => !!rt.host.status(r.runDir, 1)?.cancel); const status = rt.host.status(r.runDir, 1)!, original = structuredClone(status);
    try {
      for (const stale of [{ ...status.group!.leader, start: '0' }, { ...status.group!.leader, boot: 'previous-boot' }]) {
        const group = { ...status.group!, leader: stale }; expect(signalGroup(group, 'SIGKILL')).toBe(false);
        durableJson(join(rt.host.directory(r.runDir, 1), 'status.json'), { ...status, group }); rt.host.signal(r.runDir, 1, 'SIGKILL'); expect(alive(original.endpoint)).toBe(true);
      }
    } finally { durableJson(join(rt.host.directory(r.runDir, 1), 'status.json'), original); }
    rt.host.signal(r.runDir, 1, 'SIGKILL'); expect((await state(rt, r.id, 'interrupted')).reason).toBe('runner_crash');
  });
  it.each(['total', 'idle', 'waiting'] as const)('tick executes decide timeout_%s and preserves WIP', async clock => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), inputMode: clock === 'waiting' ? 'stdin' : 'none',
      timeouts: { [`${clock}_s`]: 2 }, prompt: clock === 'waiting' ? prompt('interactive:1') : script([{ op: 'step' }, { op: 'hang' }]) });
    rt.start(r.id);
    if (clock === 'waiting') await state(rt, r.id, 'waiting'); else await until(async () => { await rt.tick(); return rt.store.get(r.id).usage.steps === 1; });
    const c = rt.store.get(r.id).clocks, at = (clock === 'total' ? c.runningSince! - c.totalMs : clock === 'idle' ? c.idleSince! : c.waitingSince!) + 2000;
    await rt.tick(at - 1); expect(rt.store.get(r.id).stop).toBeNull(); await rt.tick(at);
    const ended = await state(rt, r.id, 'interrupted'); expect(ended.reason).toBe(`timeout_${clock}`); expect(ended.preservation.kind).toBe('wip'); expect(stopEvents(rt, r.id)).toHaveLength(1);
  });
  it('tick executes pause_budget for an unstarted zero-budget run', async () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), fakeMaxSteps: 0 }); await rt.tick();
    expect(rt.store.get(r.id)).toMatchObject({ state: 'paused', reason: 'budget_exceeded', segment: 0, reservation: false }); expect(stopEvents(rt, r.id)).toHaveLength(1);
  });
  it.each(['stdin', 'resume'] as const)('tick invalidates pending %s input when no step budget remains', async inputMode => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), inputMode, fakeMaxSteps: 1, prompt: prompt('interactive:1') });
    rt.start(r.id); await state(rt, r.id, 'waiting'); rt.message(r.id, 'pending', 'go'); await rt.tick();
    const ended = await state(rt, r.id, 'paused'); expect(ended.reason).toBe('budget_exceeded'); expect(ended.messages[0]?.state).toBe('invalidated'); expect(ended.segment).toBe(1); expect(ended.preservation.kind).toBe('wip');
  });
  it('waiting pauses total/idle; an accepted message stops waiting clock; resume retains total spent', async () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), inputMode: 'resume', timeouts: { total_s: 10, idle_s: 10, waiting_s: 10 }, prompt: prompt('interactive:1') });
    rt.start(r.id); const waiting = await state(rt, r.id, 'waiting'); expect(waiting.clocks.totalMs).toBeGreaterThan(0);
    expect(waiting.clocks.runningSince).toBeNull(); expect(waiting.clocks.idleSince).toBeNull();
    rt.message(r.id, 'accepted', 'go'); await rt.tick(waiting.clocks.waitingSince! + 100_000); expect(rt.store.get(r.id).stop).toBeNull();
    expect(rt.store.get(r.id).clocks.totalMs).toBe(waiting.clocks.totalMs); rt.start(r.id);
    expect(rt.store.get(r.id).clocks.totalMs).toBe(waiting.clocks.totalMs); await state(rt, r.id, 'done');
  });
  it('total timeout in a later segment uses the remaining run time', async () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), inputMode: 'resume', timeouts: { total_s: 5 }, prompt: script([
      { op: 'sleep', ms: 50 }, { op: 'await_input' }, { op: 'step' }, { op: 'hang' },
    ]) });
    rt.start(r.id); const waiting = await state(rt, r.id, 'waiting'); expect(waiting.clocks.totalMs).toBeGreaterThanOrEqual(50);
    rt.message(r.id, 'next', 'go'); rt.start(r.id); await until(async () => { await rt.tick(); return rt.store.get(r.id).segmentUsage['2']?.steps === 1; });
    const running = rt.store.get(r.id), deadline = running.clocks.runningSince! + 5000 - waiting.clocks.totalMs;
    await rt.tick(deadline - 1); expect(rt.store.get(r.id).stop).toBeNull(); await rt.tick(deadline);
    expect((await state(rt, r.id, 'interrupted')).reason).toBe('timeout_total');
  });
});
