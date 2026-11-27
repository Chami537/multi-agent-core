import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime, type RuntimeOptions } from '../../dist/core/runtime.js';
import { alive, durableJson, signalGroup } from '../../dist/host/process.js';
import type { Run, State } from '../../dist/core/types.js';

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
      if (s?.pgid) signalGroup(s.pgid, 'SIGKILL');
      if (s && alive(s.shim)) { try { process.kill(s.shim.pid, 'SIGKILL'); } catch { /* Gone. */ } }
    }
    runtime.close();
  }
  await delay(70);
  for (const { root } of allocations) rmSync(root, { recursive: true, force: true }); allocations.length = 0;
}
