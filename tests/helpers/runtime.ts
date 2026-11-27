import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime, type RuntimeOptions } from '../../dist/core/runtime.js';
import { durableJson, signalProcess } from '../../dist/host/process.js';
import type { Run, State } from '../../dist/core/types.js';
import type { StartParams } from '../../dist/core/types.js';
import { move } from '../../dist/core/lifecycle.js';

export const allocations: { root: string; runtime: Runtime }[] = [];
export function makeRuntime(options: Partial<RuntimeOptions> = {}): Runtime {
  const root = mkdtempSync(join(tmpdir(), 'mac-d1-'));
  const runtime = new Runtime({ root, preserve: markerPreserver, timing: { exitMs: 120, killMs: 70, graceMs: 70 }, ...options });
  allocations.push({ root, runtime }); return runtime;
}
export async function markerPreserver(run: Readonly<Run>, kind: 'wip' | 'final') {
  // Simulated domain boundary: no Git references or repository files are changed.
  durableJson(join(run.runDir, `${kind}-marker.json`), { runId: run.id, segment: run.segment, kind });
  return { state: 'saved' as const, kind, sha: null, error: null };
}
export function workspace(runtime: Runtime): string { const path = join(runtime.root, 'workspace'); mkdirSync(path, { recursive: true }); return path; }
export function prompt(scenario: unknown): string { return `\`\`\`mac-fake\n${typeof scenario === 'string' ? scenario : JSON.stringify(scenario)}\n\`\`\``; }
export function launchFixture(rt: Runtime, mode: string): Run {
  const r = rt.create({ workspace: workspace(rt) }); r.segment = 1;
  r.intent = { runId: r.id, segment: 1, segmentKind: 'initial', launchToken: randomUUID(), daemonEpoch: rt.epoch, status: 'pending' };
  rt.store.transaction(() => { move(r, 'running', null); rt.store.put(r); });
  const start: StartParams = { run_id: r.id, segment: 1, prompt: { text: 'test', format: 'markdown' }, model: { id: 'fake-high' }, reasoning_effort: { effort: 'default', native: null }, interaction: 'autonomous', workspace: { cwd: r.workspace, read_only: false, artifacts_dir: r.runDir, scratch_dir: r.runDir, readonly_paths: [] }, limits: { max_steps: null, total_s: null, idle_s: null }, forbidden: [], resume: null, raw_dir: null, conformance: null };
  rt.host.launch({ runDir: r.runDir, segment: 1, token: r.intent.launchToken, command: [process.execPath, resolve('tests/helpers/endpoint.mjs'), mode], cwd: r.workspace, env: {}, start });
  return r;
}
export async function until(predicate: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  do { if (await predicate()) return; await delay(15); } while (Date.now() < end);
  throw new Error('condition timed out');
}
export async function state(runtime: Runtime, id: string, expected: State, ms = 5_000): Promise<Run> {
  await until(async () => { await runtime.tick(); return runtime.store.get(id).state === expected; }, ms); return runtime.store.get(id);
}
export async function cleanup(): Promise<void> {
  for (const { runtime } of allocations) {
    let runs: Run[] = []; try { runs = runtime.store.list(); } catch { /* Already closed. */ }
    for (const r of runs) {
      const s = runtime.host.status(r.runDir, r.segment);
      runtime.host.signal(r.runDir, r.segment, 'SIGKILL');
      if (s) signalProcess(s.shim, 'SIGKILL');
    }
    runtime.close();
  }
  await delay(70);
  for (const { root } of allocations) rmSync(root, { recursive: true, force: true }); allocations.length = 0;
}
