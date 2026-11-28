import { afterEach, describe, expect, it } from 'vitest';
import type { Finished, RunnerEvent, Usage } from '../../dist/core/types.js';
import { FakeRunnerAdapter, type NativeStubHandle, type RunnerAdapter, type RunnerSession } from './adapter.js';

const sessions: RunnerSession[] = [];
const stubs: NativeStubHandle[] = [];

function track(session: RunnerSession): RunnerSession {
  sessions.push(session);
  return session;
}

function trackStub(stub: NativeStubHandle): NativeStubHandle {
  stubs.push(stub);
  return stub;
}

export function assertTerminalEvents(
  events: readonly RunnerEvent[],
  expectedOutcome: Finished['outcome'],
): Finished {
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events[0]?.type).toBe('session.started');
  const finishedEvents = events.filter(e => e.type === 'run.finished');
  expect(finishedEvents).toHaveLength(1);
  expect(events.at(-1)?.type).toBe('run.finished');
  const seqs = events.map(e => e.seq);
  expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  const fin = finishedEvents[0]!.data as unknown as Finished;
  expect(fin.outcome).toBe(expectedOutcome);
  return fin;
}

async function assertSingleTerminal(
  session: RunnerSession,
  expectedOutcome: Finished['outcome'],
): Promise<Finished> {
  await session.waitForEvent(e => e.type === 'run.finished');
  session.closeStdin();
  await session.waitForExit();
  return assertTerminalEvents(session.events, expectedOutcome);
}

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  for (const s of sessions) {
    try {
      s.killGroup('SIGKILL');
      await s.waitForExit().catch(() => {});
    } catch (err) {
      cleanupErrors.push(err);
    }
  }
  sessions.length = 0;
  for (const stub of stubs) {
    try {
      stub.cleanup();
    } catch (err) {
      cleanupErrors.push(err);
    }
  }
  stubs.length = 0;
  if (cleanupErrors.length > 0) {
    throw cleanupErrors[0];
  }
});

export function definePhase1ConformanceSuite(
  name: string,
  createAdapter: () => RunnerAdapter,
): void {
  describe(`Runner Protocol Phase 1 Conformance (${name})`, () => {
    it('RC-01: initialize negotiates highest common version and matches runner.id', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ sessionKind: 'control' }));
      const reply = await s.rpc('initialize', adapter.makeInit('control', {
        protocol_versions: ['0.1', ...adapter.supportedVersions],
      }));
      expect(reply.error).toBeUndefined();
      expect(reply.result?.protocol_version).toBe(adapter.supportedVersions[0]);
      expect((reply.result?.runner as Record<string, unknown>)?.id).toBe(adapter.id);

      const second = await s.rpc('initialize', adapter.makeInit('control'));
      expect(second.error?.code).toBe(-32003);
    });

    it('RC-02: initialize rejects incompatible protocol versions with -32001 and exit code 64', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ sessionKind: 'control' }));
      const reply = await s.rpc('initialize', adapter.makeInit('control', { protocol_versions: ['99.0'] }));
      expect(reply.error?.code).toBe(-32001);
      expect(reply.error?.data?.supported).toEqual(adapter.supportedVersions);
      const exit = await s.waitForExit();
      expect(exit.code).toBe(64);
    });

    it('RC-03: rejects capabilities, validate, probe, and run.start before initialize with -32002', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ sessionKind: 'control' }));
      for (const [method, params] of [
        ['capabilities', {}],
        ['validate', { start: adapter.makeStart() }],
        ['probe', { level: 'auth' }],
        ['run.start', adapter.makeStart()],
      ] as const) {
        const reply = await s.rpc(method, params);
        expect(reply.error?.code).toBe(-32002);
      }
      expect(s.events).toHaveLength(0);
    });

    it('RC-04: stdout framing is valid JSON-RPC 2.0, <= 1 MiB per line, and line-flushed before exit', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ sessionKind: 'run' }));
      await s.rpc('initialize', adapter.makeInit('run'));
      const t0 = Date.now();
      await s.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.lineFlushProbe()));

      // Controlled stub proof: events arrive on stdout while the process is still alive and sleeping.
      await s.waitForEvent(e => e.type === 'session.started', 1_000);
      await s.waitForEvent(e => e.type === 'message', 1_000);
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(s.child.exitCode).toBeNull();
      expect(s.events.some(e => e.type === 'run.finished')).toBe(false);

      await s.rpc('run.cancel', { reason: 'flush_probe_done', grace_s: 1 });
      await assertSingleTerminal(s, 'cancelled');

      expect(s.rawLines.length).toBeGreaterThan(0);
      for (const line of s.rawLines) {
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(1_048_576);
        const parsed = JSON.parse(line) as {
          jsonrpc?: string;
          id?: unknown;
          method?: string;
          params?: RunnerEvent;
          result?: unknown;
          error?: { code?: unknown; message?: unknown };
        };
        expect(parsed.jsonrpc).toBe('2.0');
        if (parsed.id !== undefined) {
          expect(parsed.result !== undefined || parsed.error !== undefined).toBe(true);
          if (parsed.error) {
            expect(typeof parsed.error.code).toBe('number');
            expect(typeof parsed.error.message).toBe('string');
          }
        } else {
          expect(parsed.method).toBe('event');
          expect(parsed.params).toBeDefined();
          expect(Number.isSafeInteger(parsed.params!.seq)).toBe(true);
          expect(parsed.params!.seq).toBeGreaterThanOrEqual(1);
          expect(typeof parsed.params!.type).toBe('string');
          expect(typeof parsed.params!.ts).toBe('string');
          expect(Number.isNaN(Date.parse(parsed.params!.ts))).toBe(false);
          expect(parsed.params!.data).toBeTypeOf('object');
        }
      }
    });

    it('RC-05: capabilities schema is self-consistent', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ sessionKind: 'control' }));
      await s.rpc('initialize', adapter.makeInit('control'));
      const caps = (await s.rpc('capabilities')).result as Record<string, any>;
      expect(caps.runner).toMatchObject({
        id: adapter.id,
        name: expect.any(String),
        impl_version: expect.any(String),
      });
      expect(caps.account).toMatchObject({ id: expect.any(String), status: expect.any(String) });

      expect(typeof caps.features.read_only.enforceable).toBe('boolean');
      expect(typeof caps.features.usage.streaming).toBe('boolean');
      expect(Array.isArray(caps.features.usage.fields)).toBe(true);
      expect(typeof caps.features.usage.native_cost).toBe('boolean');
      expect(typeof caps.features.cancel.control_message).toBe('boolean');
      expect(Number.isInteger(caps.features.cancel.grace_s)).toBe(true);
      expect(caps.features.cancel.grace_s).toBeGreaterThanOrEqual(1);
      expect(caps.features.cancel.grace_s).toBeLessThanOrEqual(60);

      const interaction = caps.features.interaction;
      expect(Array.isArray(interaction.modes)).toBe(true);
      expect(interaction.holds_slot_while_waiting).toBe(interaction.input === 'stdin');
      expect(typeof interaction.mid_turn_input).toBe('boolean');
      expect(['per_event', 'session', 'final', 'none']).toContain(caps.features.effort_reporting);

      expect(Array.isArray(caps.models)).toBe(true);
      expect(caps.models.length).toBeGreaterThan(0);
      for (const model of caps.models) {
        expect(typeof model.id).toBe('string');
        const efforts = model.efforts as { effort: string; native: string }[];
        const effortKeys = efforts.map(e => e.effort);
        const nativeKeys = efforts.map(e => e.native);
        expect(new Set(effortKeys).size).toBe(effortKeys.length);
        expect(new Set(nativeKeys).size).toBe(nativeKeys.length);
        expect(effortKeys).toContain(model.default_effort);
      }

      expect(caps.probe).toMatchObject({ levels: expect.any(Array), components: expect.any(Array) });
      expect(caps.conformance).toMatchObject({
        native_override: expect.any(Boolean),
        scenarios: expect.any(Boolean),
      });
    });

    it('RC-06: strict command parsing rejects unknown fields with -32602 and emits no events', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ sessionKind: 'control' }));
      await s.rpc('initialize', adapter.makeInit('control'));

      const vReply = await s.rpc('validate', { start: { ...adapter.makeStart(), unexpected_field: 1 } });
      expect(vReply.error?.code).toBe(-32602);
      expect(vReply.error?.data?.unknown_fields).toContain('unexpected_field');

      const sReply = await s.rpc('run.start', { ...adapter.makeStart(), unexpected_field: 1 });
      expect(sReply.error?.code).toBe(-32602);
      expect(sReply.error?.data?.unknown_fields).toContain('unexpected_field');
      expect(s.events).toHaveLength(0);
    });

    it('RC-07, RC-08, RC-09: validate and run.start enforce declared capabilities with zero native launches on rejection', async () => {
      const adapter = createAdapter();
      const probeStub = trackStub(adapter.createZeroLaunchProbeStub());

      const ctrl = track(adapter.spawn({ sessionKind: 'control', env: probeStub.env }));
      await ctrl.rpc('initialize', adapter.makeInit('control'));
      const caps = (await ctrl.rpc('capabilities')).result as Record<string, any>;

      // RC-08: rejection matrix & fast validate response
      const t0 = Date.now();
      const rejections: Array<{ start: ReturnType<RunnerAdapter['makeStart']>; rule: string }> = [
        { start: adapter.makeStart({ model: { id: 'nonexistent-model-xyz' } }), rule: 'MODEL_UNKNOWN' },
        {
          start: adapter.makeStart({ reasoning_effort: { effort: 'unsupported-effort', native: 'x' } }),
          rule: 'EFFORT_UNSUPPORTED',
        },
      ];
      if (!caps.features.read_only.enforceable) {
        rejections.push({
          start: adapter.makeStart({ workspace: { ...adapter.makeStart().workspace, read_only: true } }),
          rule: 'READ_ONLY_UNSUPPORTED',
        });
      }
      if (Array.isArray(caps.features.forbidden_enforcement) && caps.features.forbidden_enforcement.length === 0) {
        rejections.push({
          start: adapter.makeStart({ forbidden: ['git_push'] }),
          rule: 'FORBIDDEN_UNSUPPORTED',
        });
      }
      if (caps.features.interaction.input !== 'resume') {
        rejections.push({
          start: adapter.makeStart({
            resume: { token: 'tok', input: { input_id: 'i1', text: 'hi' }, usage_baseline: null },
          }),
          rule: 'RESUME_UNSUPPORTED',
        });
      }

      for (const { start, rule } of rejections) {
        const vReply = await ctrl.rpc('validate', { start });
        expect(vReply.result).toMatchObject({ ok: false, violations: [{ rule }] });
        const sReply = await ctrl.rpc('run.start', start);
        expect(sReply.error?.code).toBe(-32005);
      }
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(ctrl.events).toHaveLength(0);
      expect(probeStub.getLaunchCount()).toBe(0);

      // RC-09: validate-accepted start succeeds without -32005
      const runSess = track(adapter.spawn({ sessionKind: 'run' }));
      await runSess.rpc('initialize', adapter.makeInit('run'));
      const valid = adapter.makeScenarioStart(adapter.scenarios.ok());
      expect((await runSess.rpc('validate', { start: valid })).result?.ok).toBe(true);
      const started = await runSess.rpc('run.start', valid);
      expect(started.error).toBeUndefined();
      expect(started.result?.accepted).toBe(true);
      await assertSingleTerminal(runSess, 'completed');
    });

    it('conformance parameter is rejected with -32006 when MAC_CONFORMANCE is not 1', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ sessionKind: 'run', env: { MAC_CONFORMANCE: '0' } }));
      await s.rpc('initialize', adapter.makeInit('run', { conformance: false }));
      const reply = await s.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.ok()));
      expect(reply.error?.code).toBe(-32006);
      expect(s.events).toHaveLength(0);
    });

    it('RC-10: probe auth returns valid non-billable response', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ sessionKind: 'control' }));
      await s.rpc('initialize', adapter.makeInit('control'));
      const probe = (await s.rpc('probe', { level: 'auth' })).result as Record<string, any>;
      expect(probe.level).toBe('auth');
      expect(probe.billable).toBe(false);
      expect(['ok', 'failed']).toContain(probe.status);
      expect(typeof probe.checked_at).toBe('string');
      expect(Array.isArray(probe.components)).toBe(true);
      expect(probe.components[0]?.id).toBe('auth');
      expect(['ok', 'failed']).toContain(probe.components[0]?.status);
    });

    it('RC-12: normal completion has session.started first, contiguous seq from 1, single run.finished last, and exits 0', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ sessionKind: 'run' }));
      await s.rpc('initialize', adapter.makeInit('run'));
      await s.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.ok()));
      await s.waitForEvent(e => e.type === 'run.finished');
      s.closeStdin();
      const exit = await s.waitForExit();
      expect(exit.code).toBe(0);
      assertTerminalEvents(s.events, 'completed');

      // Negative self-check: two run.finished events must fail assertTerminalEvents
      const duplicated: RunnerEvent[] = [
        ...s.events,
        { ...s.events.at(-1)!, seq: s.events.length + 1 },
      ];
      expect(() => assertTerminalEvents(duplicated, 'completed')).toThrow();
    });

    it('RC-15 & RC-37: usage events are cumulative, streamed before completion, non-null only for reported fields, with exact basis', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ sessionKind: 'run' }));
      await s.rpc('initialize', adapter.makeInit('run'));
      const t0 = Date.now();
      await s.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.usageStream()));
      await s.waitForEvent(e => e.type === 'usage', 30_000);
      const firstUsageLatency = Date.now() - t0;
      expect(firstUsageLatency).toBeLessThan(30_000);

      const fin = await assertSingleTerminal(s, 'completed');

      const usages = s.events.filter(e => e.type === 'usage').map(e => e.data as unknown as Usage);
      expect(usages.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < usages.length; i++) {
        const prev = usages[i - 1]!;
        const curr = usages[i]!;
        if (prev.input_tokens !== null && curr.input_tokens !== null) {
          expect(curr.input_tokens).toBeGreaterThanOrEqual(prev.input_tokens);
        }
        if (prev.output_tokens !== null && curr.output_tokens !== null) {
          expect(curr.output_tokens).toBeGreaterThanOrEqual(prev.output_tokens);
        }
        if (prev.steps !== null && curr.steps !== null) {
          expect(curr.steps).toBeGreaterThanOrEqual(prev.steps);
        }
      }

      const lastUsage = usages.at(-1)!;
      // Cumulative check: 25 (not 12+25=37) and 9 (not 4+9=13)
      expect(fin.usage.completeness).toBe('exact');
      expect(fin.usage.input_tokens).toBe(25);
      expect(fin.usage.output_tokens).toBe(9);
      expect(fin.usage.steps).toBe(2);
      expect(fin.usage.cache_read_tokens).toBeNull();
      expect(fin.usage.cache_write_tokens).toBeNull();
      expect(fin.usage.native_cost_usd).toBeNull();
      expect(fin.usage.input_tokens!).toBeGreaterThanOrEqual(lastUsage.input_tokens!);
      expect(fin.usage.basis).toMatchObject({
        native_scope: expect.stringMatching(/^(segment|session|unknown)$/),
        aggregation: 'cumulative',
        cache_in_input: null,
        source: null,
      });
    });

    it('RC-16, RC-17, RC-18: model, model.changed, and effort reporting reflect native evidence without silent fallback', async () => {
      const adapter = createAdapter();
      const ctrl = track(adapter.spawn({ sessionKind: 'control' }));
      await ctrl.rpc('initialize', adapter.makeInit('control'));
      const caps = (await ctrl.rpc('capabilities')).result as Record<string, any>;
      const modelCap = (caps.models as Array<Record<string, any>>).find(m => m.id === adapter.defaultModel) ?? caps.models[0];
      const efforts = modelCap.efforts as Array<{ effort: string; native: string }>;
      const targetEffort = efforts.find(e => e.effort !== modelCap.default_effort) ?? efforts[0]!;

      // Unreported model & effort
      const s1 = track(adapter.spawn({ sessionKind: 'run' }));
      await s1.rpc('initialize', adapter.makeInit('run'));
      await s1.rpc('run.start', adapter.makeScenarioStart(
        adapter.scenarios.modelAndEffort({ modelEffective: null, effortEffective: null }),
      ));
      const fin1 = await assertSingleTerminal(s1, 'completed');
      expect(fin1.model).toMatchObject({ requested: adapter.defaultModel, effective: null, effective_source: 'unknown' });
      expect(fin1.reasoning_effort).toMatchObject({ effective: null, effective_source: 'unknown' });

      // Switched model (via model.changed with native evidence) & capability-derived effort
      const s2 = track(adapter.spawn({ sessionKind: 'run' }));
      await s2.rpc('initialize', adapter.makeInit('run'));
      await s2.rpc('run.start', adapter.makeScenarioStart(
        adapter.scenarios.modelChanged({
          modelEffective: 'other-model',
          effortEffective: targetEffort.effort,
          evidence: 'native_header_model',
        }),
      ));
      const fin2 = await assertSingleTerminal(s2, 'completed');
      const changed = s2.events.find(e => e.type === 'model.changed');
      expect(changed).toBeDefined();
      expect(changed!.data.model).toMatchObject({
        effective: 'other-model',
        effective_source: 'native_reported',
        evidence: 'native_header_model',
      });
      expect(fin2.model).toMatchObject({
        requested: adapter.defaultModel,
        effective: 'other-model',
        effective_source: 'native_reported',
        evidence: expect.any(String),
      });
      if (caps.features.effort_reporting === 'none') {
        expect(fin2.reasoning_effort).toMatchObject({ effective: null, effective_source: 'unknown' });
      } else {
        expect(fin2.reasoning_effort).toMatchObject({
          effective: targetEffort.effort,
          effective_native: targetEffort.native,
          effective_source: 'native_reported',
        });
      }
    });

    it('RC-24: work_started accurately reflects pre-work failure vs post-tool failure', async () => {
      const adapter = createAdapter();
      const s1 = track(adapter.spawn({ sessionKind: 'run' }));
      await s1.rpc('initialize', adapter.makeInit('run'));
      await s1.rpc('run.start', adapter.makeScenarioStart(
        adapter.scenarios.preWorkFail({ code: 'auth_failed', category: 'auth', retryable: false, scope: 'account' }),
      ));
      const fin1 = await assertSingleTerminal(s1, 'failed');
      expect(fin1.work_started).toBe(false);

      const s2 = track(adapter.spawn({ sessionKind: 'run' }));
      await s2.rpc('initialize', adapter.makeInit('run'));
      await s2.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.postToolFail()));
      const fin2 = await assertSingleTerminal(s2, 'failed');
      expect(fin2.work_started).toBe(true);
    });

    it('RC-25: native stub crash produces single failed/runner_crash terminal event and launches native process exactly once', async () => {
      const adapter = createAdapter();
      if (!adapter.supportsNativeOverride) return;
      const stub = trackStub(adapter.createNativeCrashStub(42));
      const s = track(adapter.spawn({ sessionKind: 'run', env: stub.env }));
      await s.rpc('initialize', adapter.makeInit('run'));
      await s.rpc('run.start', adapter.makeScenarioStart(stub.scenario));
      const fin = await assertSingleTerminal(s, 'failed');
      expect(fin.error?.code).toBe('runner_crash');
      expect(fin.native_exit?.code).toBe(42);
      expect(stub.getLaunchCount()).toBe(1);
    });

    it('RC-26: second run.start is rejected with -32003 (single start per session)', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ sessionKind: 'run' }));
      await s.rpc('initialize', adapter.makeInit('run'));
      await s.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.okSlow(0.2)));
      await s.waitForEvent(e => e.type === 'session.started');
      const dup = await s.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.ok()));
      expect(dup.error?.code).toBe(-32003);
      await assertSingleTerminal(s, 'completed');
      expect(s.events.filter(e => e.type === 'session.started')).toHaveLength(1);
    });

    it('RC-27, RC-28, RC-30, RC-36: cancel via run.cancel, SIGTERM, and stdin EOF produce single cancelled terminal event, respect grace period, and clear process group', async () => {
      const adapter = createAdapter();
      const ctrl = track(adapter.spawn({ sessionKind: 'control' }));
      await ctrl.rpc('initialize', adapter.makeInit('control'));
      const caps = (await ctrl.rpc('capabilities')).result as Record<string, any>;

      // run.cancel (works even when SIGTERM is ignored: RC-28)
      const s1 = track(adapter.spawn({ sessionKind: 'run' }));
      await s1.rpc('initialize', adapter.makeInit('run'));
      await s1.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.ignoreTerm()));
      await s1.waitForEvent(e => e.type === 'usage');
      const tCancel = Date.now();
      const graceS = Math.min(2, Number(caps.features.cancel.grace_s ?? 1));
      const cancelReply = await s1.rpc('run.cancel', { reason: 'test', grace_s: graceS });
      expect(cancelReply.result?.accepted).toBe(true);
      const fin1 = await assertSingleTerminal(s1, 'cancelled');
      expect(Date.now() - tCancel).toBeLessThan(graceS * 1000 + 1000);
      expect(fin1.error).toBeNull();
      expect(typeof fin1.work_started).toBe('boolean');
      expect(fin1.usage).toBeDefined();
      expect(fin1.model).toBeDefined();
      expect(fin1.reasoning_effort).toBeDefined();
      expect(fin1.native_exit).toBeDefined();
      expect(s1.isGroupAlive()).toBe(false);

      // SIGTERM (RC-27 & RC-36 equivalence)
      const s2 = track(adapter.spawn({ sessionKind: 'run' }));
      await s2.rpc('initialize', adapter.makeInit('run'));
      await s2.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.okSlow(5)));
      await s2.waitForEvent(e => e.type === 'session.started');
      s2.kill('SIGTERM');
      await s2.waitForExit();
      const fin2 = assertTerminalEvents(s2.events, 'cancelled');
      expect(fin2.error).toBeNull();
      expect(s2.isGroupAlive()).toBe(false);

      // stdin EOF (RC-30, when stdin interaction / stdin control is supported)
      if (caps.features.interaction.input === 'stdin') {
        const s3 = track(adapter.spawn({ sessionKind: 'run' }));
        await s3.rpc('initialize', adapter.makeInit('run'));
        await s3.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.okSlow(5)));
        await s3.waitForEvent(e => e.type === 'session.started');
        s3.closeStdin();
        const exit3 = await s3.waitForExit();
        expect(exit3.code).toBe(0);
        const fin3 = assertTerminalEvents(s3.events, 'cancelled');
        expect(fin3.error).toBeNull();
        expect(s3.isGroupAlive()).toBe(false);
      }
    });

    it('RC-38: interactive-live stdin flow handles input.requested, deduplication, conflict, and run.complete', async () => {
      const adapter = createAdapter();
      const ctrl = track(adapter.spawn({ sessionKind: 'control' }));
      await ctrl.rpc('initialize', adapter.makeInit('control'));
      const caps = (await ctrl.rpc('capabilities')).result as Record<string, any>;
      if (caps.features.interaction.input !== 'stdin') return;

      const s = track(adapter.spawn({ sessionKind: 'run' }));
      await s.rpc('initialize', adapter.makeInit('run'));
      await s.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.interactive(2), { interaction: 'interactive' }));

      await s.waitForEvent(e => e.type === 'input.requested');
      expect((await s.rpc('run.input', { input_id: 'in-1', text: 'first' })).result).toEqual({ accepted: true, duplicate: false });
      expect((await s.rpc('run.input', { input_id: 'in-1', text: 'first' })).result).toEqual({ accepted: true, duplicate: true });
      expect((await s.rpc('run.input', { input_id: 'in-1', text: 'changed' })).error?.code).toBe(-32007);

      await s.waitForEvent(e => e.type === 'input.requested' && (e.data as { turn?: number }).turn === 2);
      expect((await s.rpc('run.complete', {})).result?.accepted).toBe(true);
      await assertSingleTerminal(s, 'completed');
    });

    it('RC-39: interactive-resume yields awaiting_input and handles valid/missing/reset/session-changed usage baselines', async () => {
      const adapter = createAdapter();
      const ctrl = track(adapter.spawn({ sessionKind: 'control' }));
      await ctrl.rpc('initialize', adapter.makeInit('control'));
      const caps = (await ctrl.rpc('capabilities')).result as Record<string, any>;
      if (caps.features.interaction.input !== 'resume') return;

      const startSegment1 = async () => {
        const s1 = track(adapter.spawn({ sessionKind: 'run' }));
        await s1.rpc('initialize', adapter.makeInit('run'));
        await s1.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.interactive(1), { interaction: 'interactive' }));
        const fin1 = await assertSingleTerminal(s1, 'awaiting_input');
        expect(typeof fin1.resume_token).toBe('string');
        return fin1;
      };

      const baselineCases = [
        {
          label: 'missing_baseline',
          baseline: null,
          scenario: undefined,
          expectedTokens: 0,
        },
        {
          label: 'valid_baseline',
          baseline: { input_tokens: 100, output_tokens: 20, steps: 2 },
          scenario: adapter.scenarios.resumeSegment({ inputTokens: 130, outputTokens: 25, steps: 1 }),
          expectedTokens: 130,
        },
        {
          label: 'counter_reset',
          baseline: { input_tokens: 100, output_tokens: 20, steps: 2 },
          scenario: adapter.scenarios.resumeSegment({ inputTokens: 15, outputTokens: 3, steps: 1 }),
          expectedTokens: 15,
        },
        {
          label: 'session_change',
          baseline: { input_tokens: 100, output_tokens: 20, steps: 2 },
          scenario: adapter.scenarios.resumeSegment({
            inputTokens: 18,
            outputTokens: 5,
            steps: 1,
            nativeSessionId: 'fake-new-session-2',
          }),
          expectedTokens: 18,
        },
      ];

      for (const c of baselineCases) {
        const fin1 = await startSegment1();
        const s2 = track(adapter.spawn({ sessionKind: 'run' }));
        await s2.rpc('initialize', adapter.makeInit('run'));
        await s2.rpc('run.start', adapter.makeStart({
          segment: 2,
          interaction: 'interactive',
          conformance: c.scenario ? { scenario: c.scenario } : null,
          resume: { token: fin1.resume_token!, input: { input_id: `r-${c.label}`, text: 'continue' }, usage_baseline: c.baseline },
        }));
        const fin2 = await assertSingleTerminal(s2, 'completed');
        if (c.expectedTokens > 0) {
          expect(fin2.usage.input_tokens).toBe(c.expectedTokens);
        }
        for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'steps', 'turns', 'native_cost_usd'] as const) {
          const val = fin2.usage[k];
          if (val !== null) {
            expect(val).toBeGreaterThanOrEqual(0);
          }
        }
        expect(fin2.usage.cache_read_tokens).toBeNull();
        expect(fin2.usage.cache_write_tokens).toBeNull();
      }
    });

    it('RC-40: max-steps counts model invocations and stops with step_limit_reached', async () => {
      const adapter = createAdapter();
      const ctrl = track(adapter.spawn({ sessionKind: 'control' }));
      await ctrl.rpc('initialize', adapter.makeInit('control'));
      const caps = (await ctrl.rpc('capabilities')).result as Record<string, any>;
      if (!caps.features.limits?.max_steps) return;

      const s = track(adapter.spawn({ sessionKind: 'run' }));
      await s.rpc('initialize', adapter.makeInit('run'));
      await s.rpc('run.start', adapter.makeScenarioStart(adapter.scenarios.maxSteps(), {
        limits: { max_steps: 1, total_s: null, idle_s: null },
      }));
      const fin = await assertSingleTerminal(s, 'failed');
      expect(fin.error?.code).toBe('step_limit_reached');
      expect(fin.steps).toBe(1);
    });

    it('RC-54: runner invariants match across differently configured accounts', async () => {
      const adapter = createAdapter();
      const [acctA, acctB] = adapter.alternateAccounts;
      const s1 = track(adapter.spawn({ sessionKind: 'control', account: acctA }));
      const s2 = track(adapter.spawn({ sessionKind: 'control', account: acctB }));
      const i1 = await s1.rpc('initialize', adapter.makeInit('control'));
      const i2 = await s2.rpc('initialize', adapter.makeInit('control'));
      const c1 = (await s1.rpc('capabilities')).result as Record<string, unknown>;
      const c2 = (await s2.rpc('capabilities')).result as Record<string, unknown>;
      expect(i1.result?.protocol_version).toBe(i2.result?.protocol_version);
      expect(c1.runner).toEqual(c2.runner);
      expect(c1.conformance).toEqual(c2.conformance);
      expect(c1.extensions).toEqual(c2.extensions);
      expect((c1.account as Record<string, unknown>).id).toBe(acctA);
      expect((c2.account as Record<string, unknown>).id).toBe(acctB);
    });
  });
}

definePhase1ConformanceSuite('fake-stdin', () => new FakeRunnerAdapter('stdin'));
definePhase1ConformanceSuite('fake-resume', () => new FakeRunnerAdapter('resume'));

describe('Fake runner specific branches (non-conformance / env-gated)', () => {
  it('endpoint crash exits non-zero without fabricating run.finished', async () => {
    const adapter = new FakeRunnerAdapter('stdin');
    const s = track(adapter.spawn({ sessionKind: 'run' }));
    await s.rpc('initialize', adapter.makeInit('run'));
    await s.rpc('run.start', adapter.makeScenarioStart({
      schema: 'mac.fake-scenario/0.2',
      steps: [{ op: 'step' }, { op: 'crash', exit_code: 42 }],
    }));
    const exit = await s.waitForExit();
    expect(exit.code).toBe(42);
    expect(s.events.filter(e => e.type === 'session.started')).toHaveLength(1);
    expect(s.events.filter(e => e.type === 'run.finished')).toHaveLength(0);
  });

  it('RC-18 (effort_reporting=none): effective effort remains unknown/null', async () => {
    const adapter = new FakeRunnerAdapter('stdin');
    const s = track(adapter.spawn({ sessionKind: 'run', env: { MAC_FAKE_EFFORT_REPORTING: 'none' } }));
    await s.rpc('initialize', adapter.makeInit('run'));
    const caps = (await s.rpc('capabilities')).result as Record<string, any>;
    expect(caps.features.effort_reporting).toBe('none');
    await s.rpc('run.start', adapter.makeScenarioStart(
      adapter.scenarios.modelAndEffort({ modelEffective: 'fake-high', effortEffective: 'medium' }),
    ));
    const fin = await assertSingleTerminal(s, 'completed');
    expect(fin.reasoning_effort).toMatchObject({ effective: null, effective_native: null, effective_source: 'unknown' });
  });

  it('RC-10 (auth_failed probe): returns failed status with structured auth_failed component error', async () => {
    const adapter = new FakeRunnerAdapter('stdin');
    const s = track(adapter.spawn({ sessionKind: 'control', env: { MAC_FAKE_PROBE_STATUS: 'failed' } }));
    await s.rpc('initialize', adapter.makeInit('control'));
    const probe = (await s.rpc('probe', { level: 'auth' })).result as Record<string, any>;
    expect(probe.level).toBe('auth');
    expect(probe.billable).toBe(false);
    expect(probe.status).toBe('failed');
    expect(probe.components[0]).toMatchObject({
      id: 'auth',
      status: 'failed',
      error: {
        code: 'auth_failed',
        category: 'auth',
        retryable: false,
        scope: 'account',
        message: expect.any(String),
      },
    });
  });
});
