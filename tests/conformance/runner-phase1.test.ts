import { afterEach, describe, expect, it } from 'vitest';
import type { Finished, RunnerEvent, Usage } from '../../dist/core/types.js';
import { FakeRunnerAdapter, type RunnerAdapter, type RunnerSession } from './adapter.js';

const sessions: RunnerSession[] = [];

function track(session: RunnerSession): RunnerSession {
  sessions.push(session);
  return session;
}

const initParams = {
  protocol_versions: ['0.2'],
  host: { name: 'conformance-suite', version: '0.2.0', instance_id: 'rc-suite' },
  session_kind: 'control' as const,
  conformance: false,
};

afterEach(async () => {
  for (const s of sessions) {
    s.kill('SIGKILL');
    await s.waitForExit().catch(() => {});
  }
  sessions.length = 0;
});

export function definePhase1ConformanceSuite(
  name: string,
  createAdapter: () => RunnerAdapter,
  createResumeAdapter?: () => RunnerAdapter,
): void {
  describe(`Runner Protocol Phase 1 Conformance (${name})`, () => {
    it('RC-01: initialize negotiates highest common version and matches runner.id', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      const reply = await s.rpc('initialize', { ...initParams, protocol_versions: ['0.1', ...adapter.supportedVersions] });
      expect(reply.error).toBeUndefined();
      expect(reply.result?.protocol_version).toBe(adapter.supportedVersions[0]);
      expect((reply.result?.runner as Record<string, unknown>)?.id).toBe(adapter.id);

      const second = await s.rpc('initialize', initParams);
      expect(second.error?.code).toBe(-32003);
    });

    it('RC-02: initialize rejects incompatible protocol versions with -32001 and exit code 64', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      const reply = await s.rpc('initialize', { ...initParams, protocol_versions: ['99.0'] });
      expect(reply.error?.code).toBe(-32001);
      expect(reply.error?.data?.supported).toEqual(adapter.supportedVersions);
      const exit = await s.waitForExit();
      expect(exit.code).toBe(64);
    });

    it('RC-03: rejects capabilities, validate, probe, and run.start before initialize with -32002', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
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

    it('RC-04: stdout framing is valid JSON-RPC, <= 1 MiB per line, and line-flushed', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      await s.rpc('initialize', initParams);
      const t0 = Date.now();
      await s.rpc('run.start', adapter.makeScenarioStart('ok'));
      await s.waitForEvent(e => e.type === 'session.started', 1_000);
      expect(Date.now() - t0).toBeLessThan(1_000);
      await s.waitForEvent(e => e.type === 'run.finished');
      s.closeStdin();
      await s.waitForExit();

      expect(s.rawLines.length).toBeGreaterThan(0);
      for (const line of s.rawLines) {
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(1_048_576);
        const parsed = JSON.parse(line) as { jsonrpc?: string };
        expect(parsed.jsonrpc).toBe('2.0');
      }
    });

    it('RC-05: capabilities schema is self-consistent', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      await s.rpc('initialize', initParams);
      const caps = (await s.rpc('capabilities')).result as Record<string, any>;
      expect(caps.runner.id).toBe(adapter.id);
      expect(caps.account).toMatchObject({ id: expect.any(String), status: expect.any(String) });

      const interaction = caps.features.interaction;
      expect(interaction.holds_slot_while_waiting).toBe(interaction.input === 'stdin');

      expect(Array.isArray(caps.models)).toBe(true);
      expect(caps.models.length).toBeGreaterThan(0);
      for (const model of caps.models) {
        const efforts = model.efforts as { effort: string; native: string }[];
        const effortKeys = efforts.map(e => e.effort);
        const nativeKeys = efforts.map(e => e.native);
        expect(new Set(effortKeys).size).toBe(effortKeys.length);
        expect(new Set(nativeKeys).size).toBe(nativeKeys.length);
        expect(effortKeys).toContain(model.default_effort);
      }
    });

    it('RC-06: strict command parsing rejects unknown fields with -32602 and emits no events', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      await s.rpc('initialize', initParams);

      const vReply = await s.rpc('validate', { start: { ...adapter.makeStart(), unexpected_field: 1 } });
      expect(vReply.error?.code).toBe(-32602);
      expect(vReply.error?.data?.unknown_fields).toContain('unexpected_field');

      const sReply = await s.rpc('run.start', { ...adapter.makeStart(), unexpected_field: 1 });
      expect(sReply.error?.code).toBe(-32602);
      expect(sReply.error?.data?.unknown_fields).toContain('unexpected_field');
      expect(s.events).toHaveLength(0);
    });

    it('RC-07 & RC-08 & RC-09: validate and run.start enforce declared capabilities consistently', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      await s.rpc('initialize', initParams);
      const caps = (await s.rpc('capabilities')).result as Record<string, any>;

      // RC-08: validate responds quickly and rejects unsupported capabilities with standard rule IDs
      const t0 = Date.now();
      if (!caps.features.read_only.enforceable) {
        const ro = adapter.makeStart({ workspace: { ...adapter.makeStart().workspace, read_only: true } });
        const vRo = await s.rpc('validate', { start: ro });
        expect(vRo.result).toMatchObject({ ok: false, violations: [{ rule: 'READ_ONLY_UNSUPPORTED' }] });
        const startRo = await s.rpc('run.start', ro);
        expect(startRo.error?.code).toBe(-32005);
      }
      if (Array.isArray(caps.features.forbidden_enforcement) && caps.features.forbidden_enforcement.length === 0) {
        const fb = adapter.makeStart({ forbidden: ['git_push'] });
        const vFb = await s.rpc('validate', { start: fb });
        expect(vFb.result).toMatchObject({ ok: false, violations: [{ rule: 'FORBIDDEN_UNSUPPORTED' }] });
        const startFb = await s.rpc('run.start', fb);
        expect(startFb.error?.code).toBe(-32005);
      }
      const badModel = adapter.makeStart({ model: { id: 'nonexistent-model-xyz' } });
      expect((await s.rpc('validate', { start: badModel })).result).toMatchObject({
        ok: false,
        violations: [{ rule: 'MODEL_UNKNOWN' }],
      });
      expect((await s.rpc('run.start', badModel)).error?.code).toBe(-32005);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(s.events).toHaveLength(0);

      // RC-09: validate-accepted start succeeds without -32005
      const valid = adapter.makeScenarioStart('ok');
      expect((await s.rpc('validate', { start: valid })).result?.ok).toBe(true);
      const started = await s.rpc('run.start', valid);
      expect(started.error).toBeUndefined();
      expect(started.result?.accepted).toBe(true);
      await s.waitForEvent(e => e.type === 'run.finished');
    });

    it('conformance parameter is rejected with -32006 when MAC_CONFORMANCE is not 1', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn({ env: { MAC_CONFORMANCE: '0' } }));
      await s.rpc('initialize', initParams);
      const reply = await s.rpc('run.start', adapter.makeScenarioStart('ok'));
      expect(reply.error?.code).toBe(-32006);
      expect(s.events).toHaveLength(0);
    });

    it('RC-10: probe auth returns valid non-billable response', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      await s.rpc('initialize', initParams);
      const probe = (await s.rpc('probe', { level: 'auth' })).result as Record<string, any>;
      expect(probe.level).toBe('auth');
      expect(probe.billable).toBe(false);
      expect(['ok', 'failed']).toContain(probe.status);
      expect(probe.components[0]?.id).toBe('auth');
    });

    it('RC-12: normal completion has session.started first, contiguous seq from 1, run.finished last, and exits 0 on stdin EOF', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      await s.rpc('initialize', initParams);
      await s.rpc('run.start', adapter.makeScenarioStart('ok'));
      await s.waitForEvent(e => e.type === 'run.finished');
      s.closeStdin();
      const exit = await s.waitForExit();
      expect(exit.code).toBe(0);

      expect(s.events.length).toBeGreaterThanOrEqual(2);
      expect(s.events[0]?.type).toBe('session.started');
      expect(s.events.at(-1)?.type).toBe('run.finished');
      const seqs = s.events.map(e => e.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    });

    it('RC-15 & RC-37: usage events are monotonic, non-null only for reported fields, and run.finished.usage >= last usage', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      await s.rpc('initialize', initParams);
      const scenario = {
        schema: 'mac.fake-scenario/0.2',
        steps: [
          { op: 'step' },
          { op: 'usage', input_tokens: 12, output_tokens: 4 },
          { op: 'step' },
          { op: 'usage', input_tokens: 25, output_tokens: 9 },
          { op: 'complete', final_message: 'done' },
        ],
      };
      await s.rpc('run.start', adapter.makeScenarioStart(scenario));
      const fin = (await s.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;

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
      expect(fin.usage.completeness).toBe('exact');
      expect(fin.usage.input_tokens).toBe(25);
      expect(fin.usage.output_tokens).toBe(9);
      expect(fin.usage.cache_read_tokens).toBeNull();
      expect(fin.usage.cache_write_tokens).toBeNull();
      expect(fin.usage.input_tokens!).toBeGreaterThanOrEqual(lastUsage.input_tokens!);
      expect(fin.usage.basis).toMatchObject({
        native_scope: expect.stringMatching(/^(segment|session|unknown)$/),
        aggregation: 'cumulative',
      });
    });

    it('RC-16, RC-17, RC-18: model and effort reporting reflect native evidence without silent fallback', async () => {
      const adapter = createAdapter();
      // Unreported model & effort
      const s1 = track(adapter.spawn());
      await s1.rpc('initialize', initParams);
      await s1.rpc('run.start', adapter.makeScenarioStart({
        schema: 'mac.fake-scenario/0.2',
        model_effective: null,
        effort_effective: null,
        steps: [{ op: 'complete' }],
      }));
      const fin1 = (await s1.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;
      expect(fin1.model).toMatchObject({ requested: adapter.defaultModel, effective: null, effective_source: 'unknown' });
      expect(fin1.reasoning_effort).toMatchObject({ effective: null, effective_source: 'unknown' });

      // Switched model & explicit effort
      const s2 = track(adapter.spawn());
      await s2.rpc('initialize', initParams);
      await s2.rpc('run.start', adapter.makeScenarioStart({
        schema: 'mac.fake-scenario/0.2',
        model_effective: 'other-model',
        effort_effective: 'medium',
        steps: [{ op: 'complete' }],
      }));
      const fin2 = (await s2.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;
      expect(fin2.model).toMatchObject({ requested: adapter.defaultModel, effective: 'other-model', effective_source: 'native_reported' });
      expect(fin2.reasoning_effort).toMatchObject({ effective: 'medium', effective_native: 'm', effective_source: 'native_reported' });
    });

    it('RC-24: work_started accurately reflects pre-work failure vs post-tool failure', async () => {
      const adapter = createAdapter();
      const s1 = track(adapter.spawn());
      await s1.rpc('initialize', initParams);
      await s1.rpc('run.start', adapter.makeScenarioStart({
        schema: 'mac.fake-scenario/0.2',
        steps: [{ op: 'fail', work_started: false, error: { code: 'auth_failed', category: 'auth', retryable: false, scope: 'account' } }],
      }));
      const fin1 = (await s1.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;
      expect(fin1.outcome).toBe('failed');
      expect(fin1.work_started).toBe(false);

      const s2 = track(adapter.spawn());
      await s2.rpc('initialize', initParams);
      await s2.rpc('run.start', adapter.makeScenarioStart({
        schema: 'mac.fake-scenario/0.2',
        steps: [{ op: 'tool', tool: 'shell', kind: 'shell', summary: 'cmd', status: 'ok', duration_ms: 0 }, { op: 'fail' }],
      }));
      const fin2 = (await s2.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;
      expect(fin2.outcome).toBe('failed');
      expect(fin2.work_started).toBe(true);
    });

    it('RC-25: crash exits non-zero without retrying or fabricating run.finished', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      await s.rpc('initialize', initParams);
      await s.rpc('run.start', adapter.makeScenarioStart({
        schema: 'mac.fake-scenario/0.2',
        steps: [{ op: 'step' }, { op: 'crash', exit_code: 42 }],
      }));
      const exit = await s.waitForExit();
      expect(exit.code).toBe(42);
      expect(s.events.filter(e => e.type === 'session.started')).toHaveLength(1);
      expect(s.events.filter(e => e.type === 'run.finished')).toHaveLength(0);
    });

    it('RC-26: second run.start is rejected with -32003 (single start per control session)', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      await s.rpc('initialize', initParams);
      await s.rpc('run.start', adapter.makeScenarioStart('ok_slow:0.2'));
      await s.waitForEvent(e => e.type === 'session.started');
      const dup = await s.rpc('run.start', adapter.makeScenarioStart('ok'));
      expect(dup.error?.code).toBe(-32003);
      await s.waitForEvent(e => e.type === 'run.finished');
      expect(s.events.filter(e => e.type === 'session.started')).toHaveLength(1);
      expect(s.events.filter(e => e.type === 'run.finished')).toHaveLength(1);
    });

    it('RC-27, RC-28, RC-30, RC-36: cancel via run.cancel, SIGTERM, and stdin EOF produce single cancelled terminal event', async () => {
      const adapter = createAdapter();

      // run.cancel (works even when SIGTERM is ignored: RC-28)
      const s1 = track(adapter.spawn());
      await s1.rpc('initialize', initParams);
      await s1.rpc('run.start', adapter.makeScenarioStart('ignore_term'));
      await s1.waitForEvent(e => e.type === 'usage');
      const cancelReply = await s1.rpc('run.cancel', { reason: 'test', grace_s: 1 });
      expect(cancelReply.result?.accepted).toBe(true);
      const fin1 = (await s1.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;
      expect(fin1.outcome).toBe('cancelled');
      expect(fin1.usage).toBeDefined();

      // SIGTERM (RC-27 & RC-36 equivalence)
      const s2 = track(adapter.spawn());
      await s2.rpc('initialize', initParams);
      await s2.rpc('run.start', adapter.makeScenarioStart('ok_slow:5'));
      await s2.waitForEvent(e => e.type === 'session.started');
      s2.kill('SIGTERM');
      const fin2 = (await s2.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;
      expect(fin2.outcome).toBe('cancelled');
      await s2.waitForExit();

      // stdin EOF (RC-30)
      const s3 = track(adapter.spawn());
      await s3.rpc('initialize', initParams);
      await s3.rpc('run.start', adapter.makeScenarioStart('ok_slow:5'));
      await s3.waitForEvent(e => e.type === 'session.started');
      s3.closeStdin();
      const fin3 = (await s3.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;
      expect(fin3.outcome).toBe('cancelled');
      const exit3 = await s3.waitForExit();
      expect(exit3.code).toBe(0);
    });

    it('RC-38: interactive-live stdin flow handles input.requested, deduplication, conflict, and run.complete', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      await s.rpc('initialize', initParams);
      await s.rpc('run.start', adapter.makeScenarioStart('interactive:2', { interaction: 'interactive' }));

      // Not waiting yet -> -32004? Wait until input.requested
      await s.waitForEvent(e => e.type === 'input.requested');
      expect((await s.rpc('run.input', { input_id: 'in-1', text: 'first' })).result).toEqual({ accepted: true, duplicate: false });
      expect((await s.rpc('run.input', { input_id: 'in-1', text: 'first' })).result).toEqual({ accepted: true, duplicate: true });
      expect((await s.rpc('run.input', { input_id: 'in-1', text: 'changed' })).error?.code).toBe(-32007);

      await s.waitForEvent(e => e.type === 'input.requested' && (e.data as { turn?: number }).turn === 2);
      expect((await s.rpc('run.complete', {})).result?.accepted).toBe(true);
      const fin = (await s.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;
      expect(fin.outcome).toBe('completed');
    });

    if (createResumeAdapter) {
      it('RC-39: interactive-resume yields awaiting_input with resume_token and resumes to completion', async () => {
        const adapter = createResumeAdapter();
        const s1 = track(adapter.spawn());
        await s1.rpc('initialize', initParams);
        await s1.rpc('run.start', adapter.makeScenarioStart('interactive:1', { interaction: 'interactive' }));
        const fin1 = (await s1.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;
        expect(fin1.outcome).toBe('awaiting_input');
        expect(typeof fin1.resume_token).toBe('string');
        s1.closeStdin();
        await s1.waitForExit();

        const s2 = track(adapter.spawn());
        await s2.rpc('initialize', initParams);
        await s2.rpc('run.start', adapter.makeScenarioStart('interactive:1', {
          segment: 2,
          interaction: 'interactive',
          resume: { token: fin1.resume_token!, input: { input_id: 'r-1', text: 'continue' }, usage_baseline: null },
        }));
        const fin2 = (await s2.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;
        expect(fin2.outcome).toBe('completed');
      });
    }

    it('RC-40: max-steps counts model invocations and stops with step_limit_reached', async () => {
      const adapter = createAdapter();
      const s = track(adapter.spawn());
      await s.rpc('initialize', initParams);
      await s.rpc('run.start', adapter.makeScenarioStart({
        schema: 'mac.fake-scenario/0.2',
        steps: [
          { op: 'step' },
          { op: 'tool', tool: 'shell', kind: 'shell', summary: 't1', status: 'ok', duration_ms: 0 },
          { op: 'tool', tool: 'shell', kind: 'shell', summary: 't2', status: 'ok', duration_ms: 0 },
          { op: 'step' },
          { op: 'complete' },
        ],
      }, { limits: { max_steps: 1, total_s: null, idle_s: null } }));
      const fin = (await s.waitForEvent(e => e.type === 'run.finished')).data as unknown as Finished;
      expect(fin.outcome).toBe('failed');
      expect(fin.error?.code).toBe('step_limit_reached');
      expect(fin.steps).toBe(1);
    });

    it('RC-54: runner invariants match across differently configured accounts', async () => {
      const adapter = createAdapter();
      const s1 = track(adapter.spawn({ env: { MAC_ACCOUNT_ID: 'acct-a' } }));
      const s2 = track(adapter.spawn({ env: { MAC_ACCOUNT_ID: 'acct-b' } }));
      const i1 = await s1.rpc('initialize', initParams);
      const i2 = await s2.rpc('initialize', initParams);
      const c1 = (await s1.rpc('capabilities')).result as Record<string, unknown>;
      const c2 = (await s2.rpc('capabilities')).result as Record<string, unknown>;
      expect(i1.result?.protocol_version).toBe(i2.result?.protocol_version);
      expect(c1.runner).toEqual(c2.runner);
      expect(c1.conformance).toEqual(c2.conformance);
      expect(c1.extensions).toEqual(c2.extensions);
      expect((c1.account as Record<string, unknown>).id).toBe('acct-a');
      expect((c2.account as Record<string, unknown>).id).toBe('acct-b');
    });
  });
}

definePhase1ConformanceSuite(
  'fake',
  () => new FakeRunnerAdapter('stdin'),
  () => new FakeRunnerAdapter('resume'),
);
