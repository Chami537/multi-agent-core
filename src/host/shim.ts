import { spawn } from 'node:child_process';
import { closeSync, existsSync, fdatasyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { durableJson, groupMembers, identity, syncDirectory, tryLock } from './process.js';
import { redact } from './logs.js';
import type { CancelCapability, LaunchRecord, ShimCommand, ShimRequest, ShimStatus } from './shim-types.js';

function main(): void {
  const request = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as ShimRequest;
  const segmentDir = join(request.runDir, 'segments', String(request.segment));
  const releaseGate = tryLock(join(request.runDir, 'segments', `.${request.segment}.lock`));
  if (!releaseGate) { process.exitCode = 73; return; }
  try { mkdirSync(segmentDir, { mode: 0o700 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') { releaseGate(); process.exitCode = 73; return; } releaseGate(); throw e; }
  syncDirectory(join(request.runDir, 'segments'));
  const self = identity(process.pid);
  const release = tryLock(join(segmentDir, 'writer.lock'));
  if (!release) throw new Error('writer_lock_unavailable');
  durableJson(join(segmentDir, 'launch.json'), { token: request.token, shim: self, boot: self.boot, createdAt: Date.now() } satisfies LaunchRecord);
  mkdirSync(join(segmentDir, 'commands'), { mode: 0o700 });
  const protocolFd = openSync(join(segmentDir, 'protocol.ndjson'), 'ax', 0o600);
  const rawFd = openSync(join(segmentDir, 'raw.log'), 'ax', 0o600);
  const stderrFd = openSync(join(segmentDir, 'stderr.log'), 'ax', 0o600);
  const status: ShimStatus = { shim: self, endpoint: null, pgid: null, boot: self.boot, group: null, cancel: null, stopSentAt: null, outputDrained: false, endpointExited: false, code: null, signal: null, error: null };
  const persist = () => durableJson(join(segmentDir, 'status.json'), status);
  persist();
  const child = spawn(request.command[0]!, request.command.slice(1), { detached: true, cwd: request.cwd, env: request.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  if (child.pid) { status.endpoint = identity(child.pid); status.pgid = child.pid; status.group = { leader: status.endpoint, members: [status.endpoint] }; persist(); }
  const observeGroup = () => {
    if (!status.endpoint) return;
    const members = groupMembers(status.endpoint);
    if (JSON.stringify(members) !== JSON.stringify(status.group?.members)) { status.group = { leader: status.endpoint, members }; persist(); }
  };
  const write = (fd: number, bytes: Buffer) => { if (writeSync(fd, bytes) !== bytes.length) throw new Error('short_log_write'); };
  let rpcId = 3, finishedSeen = false, closed = false;
  const rpc = (id: number | string, method: string, params: unknown) => {
    if (!closed && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      if (method === 'run.cancel' && status.stopSentAt === null) { status.stopSentAt = Date.now(); persist(); }
    }
  };
  const pump = (stream: NodeJS.ReadableStream, fd: number, protocol: boolean) => {
    let buffer = Buffer.alloc(0), discarding = false;
    stream.on('data', (chunk: Buffer) => {
      if (discarding) {
        const end = chunk.indexOf(10); if (end < 0) return;
        chunk = chunk.subarray(end + 1); discarding = false;
      }
      buffer = Buffer.concat([buffer, chunk]);
      let end: number;
      while ((end = buffer.indexOf(10)) !== -1) {
        const line = redact(buffer.subarray(0, end).toString('utf8'));
        write(fd, Buffer.from(`${line}\n`)); buffer = buffer.subarray(end + 1);
        if (protocol) {
          try {
            const msg = JSON.parse(line) as { id?: number; result?: { protocol_version?: string; features?: { cancel?: CancelCapability } }; method?: string; params?: { type?: string } };
            if (msg.id === 1 && msg.result?.protocol_version === '0.2') rpc(2, 'capabilities', {});
            if (msg.id === 2) {
              const cancel = msg.result?.features?.cancel;
              if (cancel && typeof cancel.control_message === 'boolean' && Number.isInteger(cancel.grace_s) && cancel.grace_s >= 1 && cancel.grace_s <= 60) { status.cancel = cancel; persist(); }
              rpc(3, 'run.start', request.start);
            }
            if (msg.method === 'event' && msg.params?.type === 'run.finished') { finishedSeen = true; fdatasyncSync(fd); }
          } catch { /* Consumer diagnoses protocol violations. Never rewrite the protocol. */ }
        }
      }
      if (buffer.length > 1_048_576) {
        write(fd, Buffer.from(`${redact(buffer.toString('utf8'))}\n`)); buffer = Buffer.alloc(0);
        if (protocol) { status.error = 'line_too_large'; persist(); child.stdout.destroy(); }
        else { write(fd, Buffer.from('[mac: oversized log line truncated]\n')); discarding = true; }
      }
    });
    stream.on('end', () => {
      if (buffer.length) write(fd, Buffer.from(redact(buffer.toString('utf8'))));
      fdatasyncSync(fd);
      if (protocol) { status.outputDrained = true; persist(); }
    });
  };
  pump(child.stdout, protocolFd, true); pump(child.stderr, stderrFd, false);
  const raw = child.stdio[3]; if (raw) pump(raw as NodeJS.ReadableStream, rawFd, false);
  child.stdin.on('error', () => { closed = true; });
  rpc(1, 'initialize', { protocol_versions: ['0.2'], host: { name: 'multi-agent-core', version: '0.1.0', instance_id: 'd1' }, session_kind: 'run', conformance: request.env.MAC_CONFORMANCE === '1' });
  const sync = setInterval(() => { fdatasyncSync(protocolFd); fdatasyncSync(rawFd); fdatasyncSync(stderrFd); }, 1_000);
  const poll = setInterval(() => {
    if (!status.endpointExited) observeGroup();
    const dir = join(segmentDir, 'commands');
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
      const path = join(dir, file);
      const command = JSON.parse(readFileSync(path, 'utf8')) as ShimCommand;
      if (command.kind === 'close') { closed = true; child.stdin.end(); }
      else if (!finishedSeen) rpc(command.id ?? ++rpcId, command.method, command.params);
      unlinkSync(path);
    }
  }, 10);
  child.on('error', error => { status.error = String(error); status.endpointExited = true; persist(); });
  child.on('exit', (code, signal) => { observeGroup(); status.endpointExited = true; status.code = code; status.signal = signal; persist(); });
  child.on('close', () => {
    clearInterval(sync); clearInterval(poll); status.endpointExited = true; status.outputDrained = true; persist();
    for (const fd of [protocolFd, rawFd, stderrFd]) { fdatasyncSync(fd); closeSync(fd); }
    release(); releaseGate();
  });
}
if (process.argv[2] && existsSync(process.argv[2])) main();
