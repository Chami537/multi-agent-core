import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { identity, signalProcess, type Identity } from '../../dist/host/process.js';
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
  rpc(method: string, params?: unknown): Promise<RpcReply>;
  waitForEvent(predicate: (e: RunnerEvent) => boolean, ms?: number): Promise<RunnerEvent>;
  waitForExit(ms?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  closeStdin(): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface RunnerAdapter {
  readonly id: string;
  readonly supportedVersions: string[];
  readonly defaultModel: string;
  readonly defaultEffort: string;
  readonly defaultNativeEffort: string | null;
  spawn(options?: { env?: Record<string, string>; args?: string[]; sessionKind?: 'control' | 'run' }): RunnerSession;
  makeStart(overrides?: Partial<StartParams>): StartParams;
  makeScenarioStart(scenario: unknown, overrides?: Partial<StartParams>): StartParams;
}

export function createProcessSession(
  command: string,
  args: string[],
  env: Record<string, string>,
): RunnerSession {
  const child = spawn(command, args, { env: { ...process.env, ...env } });
  const procIdentity = identity(child.pid!);
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
  };
}

export class FakeRunnerAdapter implements RunnerAdapter {
  readonly id = 'fake';
  readonly supportedVersions = ['0.2'];
  readonly defaultModel = 'fake-high';
  readonly defaultEffort = 'default';
  readonly defaultNativeEffort = null;

  constructor(private readonly mode: 'stdin' | 'resume' = 'stdin') {}

  spawn(options: { env?: Record<string, string>; args?: string[]; sessionKind?: 'control' | 'run' } = {}): RunnerSession {
    const args = [resolve('dist/runners/fake.js'), ...(this.mode === 'resume' ? ['--resume'] : []), ...(options.args ?? [])];
    const env: Record<string, string> = {
      MAC_SESSION_KIND: options.sessionKind ?? 'control',
      MAC_CONFORMANCE: '1',
      ...options.env,
    };
    return createProcessSession(process.execPath, args, env);
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
}
