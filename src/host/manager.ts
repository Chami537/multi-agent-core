import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alive, bootId, durableJson, groupAlive, jsonFile, signalGroup, syncDirectory, tryLock } from './process.js';
import type { LaunchRecord, ShimCommand, ShimRequest, ShimStatus } from './shim-types.js';
import type { LaunchIntent } from '../core/types.js';

export class Host {
  directory(runDir: string, segment: number): string { return join(runDir, 'segments', String(segment)); }
  launch(request: ShimRequest): void {
    mkdirSync(join(request.runDir, 'segments'), { recursive: true, mode: 0o700 });
    mkdirSync(join(request.runDir, 'launches'), { recursive: true, mode: 0o700 });
    const file = join(request.runDir, 'launches', `${request.segment}-${request.token}.json`);
    durableJson(file, request);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./shim.js', import.meta.url)), file], { detached: true, stdio: 'ignore', env: {} });
    child.unref(); // No daemon IPC/stdin/stdout dependency. The shim owns the runner pipes.
  }
  status(runDir: string, segment: number): ShimStatus | null { return jsonFile<ShimStatus>(join(this.directory(runDir, segment), 'status.json')); }
  launchRecord(runDir: string, segment: number): LaunchRecord | null { return jsonFile<LaunchRecord>(join(this.directory(runDir, segment), 'launch.json')); }
  facts(runDir: string, segment: number): { shimAlive: boolean; endpointAlive: boolean; groupAlive: boolean; outputDrained: boolean; status: ShimStatus | null } {
    const status = this.status(runDir, segment), record = this.launchRecord(runDir, segment);
    const sameBoot = status?.boot === bootId();
    return { shimAlive: alive(status?.shim ?? record?.shim ?? null), endpointAlive: alive(status?.endpoint ?? null),
      groupAlive: !!status?.pgid && sameBoot && groupAlive(status.pgid), outputDrained: status?.outputDrained ?? false, status };
  }
  command(runDir: string, segment: number, command: ShimCommand): void {
    const dir = join(this.directory(runDir, segment), 'commands');
    const id = command.kind === 'rpc' && command.id ? createHash('sha256').update(command.id).digest('hex') : `${Date.now()}-${randomUUID()}`;
    durableJson(join(dir, `${id}.json`), command);
  }
  signal(runDir: string, segment: number, signal: NodeJS.Signals): void {
    const status = this.status(runDir, segment);
    if (status?.pgid && status.boot === bootId()) signalGroup(status.pgid, signal);
  }
  fenceMissing(runDir: string, intent: LaunchIntent): 'void' | 'existing' | 'busy' {
    const dir = this.directory(runDir, intent.segment);
    mkdirSync(join(runDir, 'segments'), { recursive: true, mode: 0o700 });
    const release = tryLock(join(runDir, 'segments', `.${intent.segment}.lock`));
    if (!release) return 'busy';
    try {
      try { mkdirSync(dir, { mode: 0o700 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'existing'; throw e; }
    // mkdir itself is the fence, including a crash before void.json can be written.
    durableJson(join(dir, 'void.json'), { token: intent.launchToken, at: Date.now() }); syncDirectory(join(runDir, 'segments'));
    return 'void';
    } finally { release(); }
  }
  isVoid(runDir: string, segment: number): boolean { return existsSync(join(this.directory(runDir, segment), 'void.json')); }
}
export function safeEnvironment(cwd: string, accountHome: string, artifacts: string, scratch: string): Record<string, string> {
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: accountHome, TMPDIR: scratch,
    MAC_ACCOUNT_HOME: accountHome, MAC_ACCOUNT_ID: 'fake', MAC_INSTANCE_ID: 'd1', MAC_SESSION_KIND: 'run', MAC_RUNNER_PROTOCOL: '0.2',
    MAC_ARTIFACTS_DIR: artifacts, PWD: cwd, GIT_TERMINAL_PROMPT: '0' };
}
