import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { groupAlive, identity, signalGroup, signalProcess, type Identity } from '../../dist/host/process.js';
import type { RunnerEvent, StartParams } from '../../dist/core/types.js';
import { until } from '../helpers/runtime.js';

export interface RpcReply {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

export interface RunnerSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly identity: Identity;
  readonly events: RunnerEvent[];
  readonly rawLines: string[];
  getStderr(): string;
  isGroupAlive(): boolean;
  rpc(method: string, params?: unknown): Promise<RpcReply>;
  waitForEvent(predicate: (e: RunnerEvent) => boolean, ms?: number): Promise<RunnerEvent>;
  waitForExit(ms?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  closeStdin(): void;
  kill(signal?: NodeJS.Signals): void;
  killGroup(signal?: NodeJS.Signals): void;
}

export interface NativeStubHandle {
  readonly env: Record<string, string>;
  readonly scenario: unknown;
  getLaunchCount(): number;
  cleanup(): void;
}

export interface AdapterScenarios {
  ok(): unknown;
  okSlow(seconds: number): unknown;
  ignoreTerm(): unknown;
  interactive(turns: number): unknown;
  lineFlushProbe(): unknown;
  usageStream(): unknown;
  modelAndEffort(opts: {
    modelEffective: string | null;
    effortEffective: string | null;
  }): unknown;
  modelChanged(opts: {
    modelEffective: string;
    effortEffective?: string | null;
    evidence?: string;
  }): unknown;
  preWorkFail(error: Record<string, unknown>): unknown;
  postToolFail(): unknown;
  maxSteps(): unknown;
  resumeSegment(opts: {
    inputTokens: number;
    outputTokens: number;
    steps?: number;
    nativeSessionId?: string | null;
  }): unknown;
}

export interface RunnerAdapter {
  readonly id: string;
  readonly supportedVersions: string[];
  readonly defaultModel: string;
  readonly defaultEffort: string;
  readonly defaultNativeEffort: string | null;
  readonly alternateAccounts: readonly [string, string];
  readonly supportsScenarios: boolean;
  readonly supportsNativeOverride: boolean;
  readonly scenarios: AdapterScenarios;
  spawn(options?: {
    env?: Record<string, string>;
    args?: string[];
    sessionKind?: 'control' | 'run';
    account?: string;
  }): RunnerSession;
  makeInit(sessionKind?: 'control' | 'run', overrides?: Record<string, unknown>): Record<string, unknown>;
  makeStart(overrides?: Partial<StartParams>): StartParams;
  makeScenarioStart(scenario: unknown, overrides?: Partial<StartParams>): StartParams;
  createNativeCrashStub(exitCode?: number): NativeStubHandle;
  createZeroLaunchProbeStub(): NativeStubHandle;
}

export function createProcessSession(
  command: string,
  args: string[],
  env: Record<string, string>,
): RunnerSession {
  const child = spawn(command, args, { env: { ...process.env, ...env }, detached: true });
  const procIdentity = identity(child.pid!);
  const pgid = child.pid!;
  let nextId = 0;
  const replies = new Map<number, RpcReply>();
  const events: RunnerEvent[] = [];
  const rawLines: string[] = [];
  let stderr = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(res => {
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      res(exited);
    });
  });

  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
  });

  createInterface({ input: child.stdout }).on('line', line => {
    rawLines.push(line);
    const frame = JSON.parse(line) as { id?: number; method?: string; params?: RunnerEvent };
    if (frame.id !== undefined) {
      replies.set(frame.id, frame as RpcReply);
    } else if (frame.method === 'event' && frame.params) {
      events.push(frame.params);
    }
  });

  return {
    child,
    identity: procIdentity,
    events,
    rawLines,
    getStderr: () => stderr,
    isGroupAlive: () => groupAlive(pgid),
    async rpc(method: string, params: unknown = {}): Promise<RpcReply> {
      const id = ++nextId;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      await until(() => replies.has(id) || exited !== null, 5_000);
      if (!replies.has(id)) {
        throw new Error(`process exited before replying to ${method} (code=${exited?.code}, signal=${exited?.signal})`);
      }
      return replies.get(id)!;
    },
    async waitForEvent(predicate: (e: RunnerEvent) => boolean, ms = 5_000): Promise<RunnerEvent> {
      await until(() => events.some(predicate), ms);
      return events.find(predicate)!;
    },
    async waitForExit(ms = 5_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
      if (exited) return exited;
      return Promise.race([
        exitPromise,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('exit timed out')), ms)),
      ]);
    },
    closeStdin(): void {
      child.stdin.end();
    },
    kill(signal: NodeJS.Signals = 'SIGKILL'): void {
      if (child.exitCode === null && child.signalCode === null) {
        signalProcess(procIdentity, signal);
      }
    },
    killGroup(signal: NodeJS.Signals = 'SIGKILL'): void {
      if (groupAlive(pgid)) {
        signalGroup({ leader: procIdentity, members: [procIdentity] }, signal);
      }
    },
  };
}

export class FakeRunnerAdapter implements RunnerAdapter {
  readonly id = 'fake';
  readonly supportedVersions = ['0.2'];
  readonly defaultModel = 'fake-high';
  readonly defaultEffort = 'default';
  readonly defaultNativeEffort = null;
  readonly alternateAccounts = ['acct-a', 'acct-b'] as const;
  readonly supportsScenarios = true;
  readonly supportsNativeOverride = true;

  readonly scenarios: AdapterScenarios = {
    ok: () => 'ok',
    okSlow: seconds => `ok_slow:${seconds}`,
    ignoreTerm: () => 'ignore_term',
    interactive: turns => `interactive:${turns}`,
    lineFlushProbe: () => ({
      schema: 'mac.fake-scenario/0.2',
      steps: [
        { op: 'step' },
        { op: 'message', text: 'flushed-before-exit', final: false },
        { op: 'sleep', ms: 5000 },
        { op: 'complete', final_message: 'done' },
      ],
    }),
    usageStream: () => ({
      schema: 'mac.fake-scenario/0.2',
      steps: [
        { op: 'step' },
        { op: 'usage', input_tokens: 12, output_tokens: 4 },
        { op: 'sleep', ms: 20 },
        { op: 'step' },
        { op: 'usage', input_tokens: 25, output_tokens: 9 },
        { op: 'complete', final_message: 'done' },
      ],
    }),
    modelAndEffort: ({ modelEffective, effortEffective }) => ({
      schema: 'mac.fake-scenario/0.2',
      model_effective: modelEffective,
      effort_effective: effortEffective,
      steps: [{ op: 'complete' }],
    }),
    modelChanged: ({ modelEffective, effortEffective, evidence }) => ({
      schema: 'mac.fake-scenario/0.2',
      steps: [
        { op: 'step' },
        { op: 'model_changed', model_effective: modelEffective, effort_effective: effortEffective, evidence: evidence ?? 'native_header_model' },
        { op: 'complete' },
      ],
    }),
    preWorkFail: error => ({
      schema: 'mac.fake-scenario/0.2',
      steps: [{ op: 'fail', work_started: false, error }],
    }),
    postToolFail: () => ({
      schema: 'mac.fake-scenario/0.2',
      steps: [{ op: 'tool', tool: 'shell', kind: 'shell', summary: 'cmd', status: 'ok', duration_ms: 0 }, { op: 'fail' }],
    }),
    maxSteps: () => ({
      schema: 'mac.fake-scenario/0.2',
      steps: [
        { op: 'step' },
        { op: 'tool', tool: 'shell', kind: 'shell', summary: 't1', status: 'ok', duration_ms: 0 },
        { op: 'tool', tool: 'shell', kind: 'shell', summary: 't2', status: 'ok', duration_ms: 0 },
        { op: 'step' },
        { op: 'complete' },
      ],
    }),
    resumeSegment: ({ inputTokens, outputTokens, steps = 1, nativeSessionId }) => ({
      schema: 'mac.fake-scenario/0.2',
      ...(nativeSessionId !== undefined ? { native_session_id: nativeSessionId } : {}),
      steps: [
        ...Array.from({ length: steps }, () => ({ op: 'step' })),
        { op: 'usage', input_tokens: inputTokens, output_tokens: outputTokens },
        { op: 'complete', final_message: 'resumed-done' },
      ],
    }),
  };

  constructor(private readonly mode: 'stdin' | 'resume' = 'stdin') {}

  spawn(options: { env?: Record<string, string>; args?: string[]; sessionKind?: 'control' | 'run'; account?: string } = {}): RunnerSession {
    const args = [resolve('dist/runners/fake.js'), ...(this.mode === 'resume' ? ['--resume'] : []), ...(options.args ?? [])];
    const env: Record<string, string> = {
      MAC_SESSION_KIND: options.sessionKind ?? 'control',
      MAC_CONFORMANCE: '1',
      ...(options.account ? { MAC_ACCOUNT_ID: options.account } : {}),
      ...options.env,
    };
    return createProcessSession(process.execPath, args, env);
  }

  makeInit(sessionKind: 'control' | 'run' = 'control', overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      protocol_versions: [...this.supportedVersions],
      host: { name: 'conformance-suite', version: '0.2.0', instance_id: 'rc-suite' },
      session_kind: sessionKind,
      conformance: true,
      ...overrides,
    };
  }

  makeStart(overrides: Partial<StartParams> = {}): StartParams {
    return {
      run_id: 'rc-test',
      segment: 1,
      prompt: { text: 'hello', format: 'markdown' },
      model: { id: this.defaultModel },
      reasoning_effort: { effort: this.defaultEffort, native: this.defaultNativeEffort },
      interaction: 'autonomous',
      workspace: {
        cwd: process.cwd(),
        read_only: false,
        artifacts_dir: process.cwd(),
        scratch_dir: process.cwd(),
        readonly_paths: [],
      },
      limits: { max_steps: null, total_s: null, idle_s: null },
      forbidden: [],
      resume: null,
      raw_dir: null,
      conformance: null,
      ...overrides,
    };
  }

  makeScenarioStart(scenario: unknown, overrides: Partial<StartParams> = {}): StartParams {
    return this.makeStart({
      conformance: { scenario },
      ...overrides,
    });
  }

  createNativeCrashStub(exitCode = 42): NativeStubHandle {
    const dir = mkdtempSync(join(tmpdir(), 'mac-native-stub-'));
    const countFile = join(dir, 'launches.log');
    const stubFile = join(dir, 'stub.mjs');
    writeFileSync(
      stubFile,
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(countFile)}, '1\\n');\nprocess.exit(Number(process.env.MAC_NATIVE_EXIT_CODE ?? ${exitCode}));\n`,
    );
    return {
      env: { MAC_FAKE_NATIVE_STUB: stubFile },
      scenario: {
        schema: 'mac.fake-scenario/0.2',
        steps: [{ op: 'step' }, { op: 'native_crash', exit_code: exitCode }],
      },
      getLaunchCount: () => (existsSync(countFile) ? readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean).length : 0),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  createZeroLaunchProbeStub(): NativeStubHandle {
    return this.createNativeCrashStub(1);
  }
}
