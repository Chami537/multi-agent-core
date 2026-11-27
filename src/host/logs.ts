import { createHash } from 'node:crypto';
import { closeSync, fdatasyncSync, openSync, readFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { alive, bootId, groupAlive, tryLock, type Identity } from './process.js';

export function redact(text: string): string {
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
}
export interface Producer { shim: Identity; pgid: number | null; boot: string }
export function repairTail(directory: string, producer: Producer): { removed: number; digest: string } | null {
  // Neither a caller boolean nor PID alone is proof. Require lock + boot/start identity + empty group.
  const release = tryLock(join(directory, 'writer.lock'));
  if (!release) return null;
  try {
    if (alive(producer.shim) || (producer.pgid !== null && producer.boot === bootId() && groupAlive(producer.pgid))) return null;
    const file = join(directory, 'protocol.ndjson');
    const data = readFileSync(file);
    const end = data.lastIndexOf(10) + 1;
    if (end === data.length) return { removed: 0, digest: createHash('sha256').update('').digest('hex') };
    const tail = data.subarray(end);
    truncateSync(file, end);
    const fd = openSync(file, 'r+'); try { fdatasyncSync(fd); } finally { closeSync(fd); }
    return { removed: tail.length, digest: createHash('sha256').update(tail).digest('hex') };
  } finally { release(); }
}
