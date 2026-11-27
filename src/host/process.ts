import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

export interface Identity { pid: number; start: string; boot: string }
export function bootId(): string { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
export function processInfo(pid: number): { state: string; group: number; start: string } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0]!, group: Number(fields[2]), start: fields[19]! };
  } catch { return null; }
}
export function identity(pid: number): Identity {
  const info = processInfo(pid); if (!info) throw new Error(`process_missing: ${pid}`);
  return { pid, start: info.start, boot: bootId() };
}
export function alive(who: Identity | null): boolean {
  if (!who || who.boot !== bootId()) return false;
  const info = processInfo(who.pid); return !!info && info.state !== 'Z' && info.start === who.start;
}
export function groupAlive(pgid: number): boolean {
  return readdirSync('/proc').some(s => /^\d+$/.test(s) && (() => { const p = processInfo(Number(s)); return p?.group === pgid && p.state !== 'Z'; })());
}
export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (pgid <= 1 || pgid === process.pid) throw new Error('unsafe_process_group');
  try { process.kill(-pgid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
}
// flock shares the open-file description with this process; fd remains locked after the helper exits.
export function tryLock(path: string): (() => void) | null {
  const fd = openSync(path, 'a', 0o600);
  const result = spawnSync('/usr/bin/flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 2_000 });
  if (result.error || (result.status !== 0 && result.status !== 1)) { closeSync(fd); throw new Error(`flock_unavailable: ${result.error ?? result.status}`); }
  if (result.status === 1) { closeSync(fd); return null; }
  return () => closeSync(fd);
}
export function durableJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  syncDirectory(dirname(path));
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function jsonFile<T>(path: string): T | null { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : null; }
