import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/database.js';
import { ingest, stateEvent } from '../store/ingest.js';
import { Host, safeEnvironment } from '../host/manager.js';
import { bootId, tryLock } from '../host/process.js';
import { workspaceState } from '../host/workspace.js';
import { environmentFailure, nativeEffort, noWorkProduced } from './launch.js';
import { repairTail } from '../host/logs.js';
import { decide, type Snapshot } from './decide.js';
import { candidateOutcome, cleanupAction, defaultTiming, finalize, move, recordCandidate, requestStop, type Timing } from './lifecycle.js';
import { assertTransition, isTerminal } from './state-machine.js';
import { unsupported } from './unsupported.js';
import { aggregateUsage } from './usage.js';
import { emptyUsage, type Finished, type InputMode, type Preservation, type Role, type Run, type StartParams, type StopKind, type Timeouts } from './types.js';

export type Preserver = (run: Readonly<Run>, kind: 'wip' | 'final') => Promise<Preservation>;
export interface RuntimeOptions {
  root: string; preserve: Preserver; globalLimit?: number; timing?: Timing; boot?: string;
}
export interface CreateRun {
  id?: string; projectId?: string; taskId?: string; account?: string; workspace: string; prompt?: string;
  inputMode?: InputMode; role?: Role; model?: string; reasoningEffort?: string;
  // Internal fake harness limit; D1 does not expose public Supervisor budget fields.
  fakeMaxSteps?: number | null;
  timeouts?: Partial<Timeouts>;
  readOnly?: boolean;
  forbidden?: string[];
  modelAliases?: string[];
}
export class Runtime {
  readonly store: Store;
  readonly host = new Host();
  readonly epoch: number;
  readonly hostRestart: boolean;
  readonly root: string;
  private readonly release: () => void;
  private ticking = false;
  private closed = false;
  private readonly timing: Timing;
  private prepareStartHook: ((run: Run, now: number) => { workspace: string; workspaceHead?: string | null } | void) | null = null;
  setPrepareStart(hook: (run: Run, now: number) => { workspace: string; workspaceHead?: string | null } | void): void {
    this.prepareStartHook = hook;
  }
  private beforeFinalizeHook: ((run: Run, now: number) => void) | null = null;
  private finalizedHook: ((run: Run, now: number) => void) | null = null;
  setFinalizeHooks(before: (run: Run, now: number) => void, after: (run: Run, now: number) => void): void {
    this.beforeFinalizeHook = before;
    this.finalizedHook = after;
  }
  private finalizeRun(run: Run, preservationOK = true, now = Date.now()): void {
    if (candidateOutcome(run).state !== 'waiting') {
      if (run.segment > 0) run.workspaceHead = workspaceState(run.workspace).head;
      this.beforeFinalizeHook?.(run, now);
    }
    finalize(run, preservationOK && !run.deliverableInvalid, now);
    if (isTerminal(run.state)) this.finalizedHook?.(run, now);
  }
  constructor(private readonly options: RuntimeOptions) {
    this.root = resolve(options.root); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const release = tryLock(join(this.root, 'instance.lock')); if (!release) throw new Error('instance_locked');
    this.release = release; this.timing = options.timing ?? defaultTiming;
    try {
      this.store = new Store(join(this.root, 'state.sqlite'));
      const info = this.store.beginEpoch(options.boot ?? bootId()); this.epoch = info.epoch; this.hostRestart = info.hostRestart;
    } catch (error) { release(); throw error; }
  }
  create(options: CreateRun): Run {
    const allowed = ['id','projectId','taskId','account','workspace','prompt','inputMode','role','model','reasoningEffort','fakeMaxSteps','timeouts','readOnly','forbidden','modelAliases'];
    for (const key of Object.keys(options)) if (!allowed.includes(key)) unsupported(key, ['budget', 'max_steps'].includes(key) ? 'Phase 3' : 'D2 or later');
    if (options.role && !['dev', 'design'].includes(options.role)) unsupported(`role:${options.role}`, 'Phase 4');
    if (options.model && options.model !== 'fake-high') throw new Error('MODEL_UNAVAILABLE');
    if (options.reasoningEffort && !['default','low','medium','high'].includes(options.reasoningEffort)) throw new Error('EFFORT_UNSUPPORTED');
    if (options.inputMode !== undefined && !['none','stdin','resume'].includes(options.inputMode)) throw new Error('invalid_input_mode');
    if (options.fakeMaxSteps != null && (!Number.isSafeInteger(options.fakeMaxSteps) || options.fakeMaxSteps < 0)) throw new Error('invalid_step_limit');
    const timeouts: Timeouts = { total_s: null, idle_s: null, waiting_s: null, ...options.timeouts };
    if (Object.entries(timeouts).some(([key, value]) => !['total_s','idle_s','waiting_s'].includes(key) || (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)))) throw new Error('invalid_timeouts');
    if (options.prompt !== undefined && (typeof options.prompt !== 'string' || Buffer.byteLength(options.prompt) > 900 * 1024)) throw new Error('invalid_prompt');
    if (options.account !== undefined && !/^[\w-]+$/.test(options.account)) throw new Error('invalid_account');
    if (!existsSync(options.workspace) || !statSync(options.workspace).isDirectory()) throw new Error('invalid_workspace');
    const id = options.id ?? `run_${randomUUID()}`;
    if (!/^[\w-]+$/.test(id)) throw new Error('invalid_run_id');
    if (this.store.db.prepare('SELECT id FROM runs WHERE id=?').get(id)) throw new Error('run_exists');
    const runDir = join(this.root, 'runs', id);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const run: Run = { id, projectId: options.projectId ?? 'default', taskId: options.taskId ?? 'default', account: options.account ?? 'fake', runner: 'fake',
      state: 'queued', reason: null, version: 1, inputMode: options.inputMode ?? 'none', role: options.role ?? 'dev', model: options.model ?? 'fake-high', reasoningEffort: options.reasoningEffort ?? 'default',
      reservation: false, segment: 0, launchAttempts: 0, intent: null, finalizing: false, stop: null, candidate: null,
      usage: aggregateUsage({}), segmentUsage: {}, previousSteps: 0, protocolViolation: null, timeouts, clocks: { totalMs: 0, runningSince: null, idleSince: null, waitingSince: null }, preservation: { state: 'not_required', kind: null, error: null, sha: null }, protected: false, messages: [], resumeToken: null,
      cleanupTermAt: null, outputDrained: false, groupEmpty: false, workspaceHead: null, hadWorkEvents: false, workspace: resolve(options.workspace), runDir, prompt: options.prompt ?? '', maxSteps: options.fakeMaxSteps ?? null,
      readOnly: Boolean(options.readOnly ?? false), forbidden: options.forbidden ? [...options.forbidden] : [], modelAliases: options.modelAliases ? [...options.modelAliases] : [] };
    assertTransition(null, 'queued', 'T1');
    this.store.transaction(() => { this.store.put(run); this.store.emit('run.created', { run, version: run.version }, run); stateEvent(this.store, run, null, Date.now()); });
    return run;
  }
  private snapshot(): Snapshot {
    const accounts: Snapshot['accounts'] & Record<string, { limit: number; healthy: boolean; frozenUntil: number | null }> = {};
    const runs = this.store.list().map(run => {
      const facts = run.segment ? this.host.facts(run.runDir, run.segment) : null;
      accounts[run.account] = { limit: this.options.globalLimit ?? 1, healthy: true, frozenUntil: null };
      return { id: run.id, state: run.state, inputMode: run.inputMode, reservation: run.reservation, projectId: run.projectId, account: run.account,
        intent: run.intent, intentConfirmed: run.intent?.status === 'spawned', shimAlive: facts?.shimAlive ?? false, groupAlive: facts?.groupAlive ?? false,
        pendingMessages: run.messages.filter(m => m.state === 'pending').length, lease: 'none' as const,
        budgetRemaining: run.maxSteps === null || (run.usage.steps ?? 0) < run.maxSteps,
        deadlines: this.deadlines(run), finalizing: run.finalizing, stopping: !!run.stop };
    });
    return { runs, globalLimit: this.options.globalLimit ?? 1, projectLimits: {}, accounts };
  }
  private deadlines(run: Run): { total: number | null; idle: number | null; waiting: number | null } {
    const { clocks: c, timeouts: t } = run;
    return { total: run.state === 'running' && c.runningSince !== null && t.total_s !== null ? c.runningSince + t.total_s * 1000 - c.totalMs : null,
      idle: run.state === 'running' && c.idleSince !== null && t.idle_s !== null ? c.idleSince + t.idle_s * 1000 : null,
      waiting: run.state === 'waiting' && c.waitingSince !== null && t.waiting_s !== null ? c.waitingSince + t.waiting_s * 1000 : null };
  }
  start(id: string, now = Date.now()): void {
    const eligible = decide(this.snapshot(), now).some(d => d.runId === id && ['start', 'deliver_input'].includes(d.action));
    if (!eligible) throw new Error('capacity_or_state_unavailable');
    const r = this.store.get(id);
    if (r.state === 'waiting' && r.inputMode === 'stdin') { this.deliverStdin(r, now); return; }
    if (!['queued','leasing','waiting'].includes(r.state)) throw new Error('invalid_start_state');
    const isResume = r.state === 'waiting';
    if (!isResume && r.segment === 0 && this.prepareStartHook) {
      const prep = this.prepareStartHook(r, now);
      if (prep?.workspace) r.workspace = resolve(prep.workspace);
    }
    const workspaceBefore = workspaceState(r.workspace);
    const message = r.messages.find(m => m.state === 'pending');
    this.store.transaction(() => {
      const from = r.state;
      r.startResolution = { model: r.model, nativeEffort: nativeEffort(r.reasoningEffort) };
      r.previousSteps = r.usage.steps ?? 0;
      r.segment++; r.intent = { runId: r.id, segment: r.segment, segmentKind: isResume ? 'resume' : r.launchAttempts ? 'launch_retry' : 'initial', launchToken: randomUUID(), daemonEpoch: this.epoch, status: 'pending' };
      r.candidate = null; r.stop = null; r.finalizing = false; r.cleanupTermAt = null; r.segmentUsage[r.segment] = emptyUsage(); r.usage = aggregateUsage(r.segmentUsage); r.protocolViolation = null;
      r.workspaceHead = workspaceBefore.head; r.hadWorkEvents = false;
      r.outputDrained = false; r.groupEmpty = false; r.preservation = { state: 'not_required', kind: null, error: null, sha: null };
      if (isResume && message) message.state = 'delivered';
      move(r, 'running', null, isResume ? 'T10' : 'T5', now); this.store.put(r); stateEvent(this.store, r, from, now);
      this.store.activity(r, r.segment, 'mac.segment_started', { intent: r.intent });
    });
    const artifacts = join(r.runDir, 'artifacts'), scratch = join(r.runDir, 'scratch'), home = join(this.root, 'accounts', r.account);
    for (const directory of [artifacts, scratch, home]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const native = r.startResolution!.nativeEffort;
    const start: StartParams = { run_id: id, segment: r.segment, prompt: { text: r.prompt, format: 'markdown' }, model: { id: r.model }, reasoning_effort: { effort: r.reasoningEffort, native },
      interaction: r.inputMode === 'none' ? 'autonomous' : 'interactive', workspace: { cwd: r.workspace, read_only: Boolean(r.readOnly), artifacts_dir: artifacts, scratch_dir: scratch, readonly_paths: [] },
      limits: { max_steps: r.maxSteps === null ? null : r.maxSteps - r.previousSteps, total_s: r.timeouts.total_s === null ? null : Math.max(0, r.timeouts.total_s - r.clocks.totalMs / 1000), idle_s: r.timeouts.idle_s }, forbidden: r.forbidden ?? [],
      resume: isResume && message && r.resumeToken ? { token: r.resumeToken, input: { input_id: message.id, text: message.text }, usage_baseline: null } : null,
      raw_dir: null, conformance: null };
    this.host.launch({ runDir: r.runDir, segment: r.segment, token: r.intent!.launchToken,
      command: [process.execPath, fileURLToPath(new URL('../runners/fake.js', import.meta.url)), ...(r.inputMode === 'resume' ? ['--resume'] : [])],
      cwd: r.workspace, env: { ...safeEnvironment(r.workspace, home, artifacts, scratch), MAC_RUN_ID: id }, start });
  }
  message(id: string, messageId: string, text: string): void {
    this.store.transaction(() => {
      this.messageInTransaction(id, messageId, text);
    });
  }
  messageInTransaction(id: string, messageId: string, text: string): Run {
    const r = this.store.get(id);
    if (r.state !== 'waiting' || r.stop || r.finalizing) throw new Error('invalid_message_state');
    const existing = r.messages.find(m => m.id === messageId);
    if (existing) { if (existing.text !== text) throw new Error('input_conflict'); return r; }
    r.messages.push({ id: messageId, text, state: 'pending' }); r.clocks.waitingSince = null; r.version++; this.store.put(r);
    this.store.emit('run.updated', { version: r.version, changes: { message: messageId } }, r);
    return r;
  }
  private deliverStdin(r: Run, now: number): void {
    const message = r.messages.find(m => m.state === 'pending'); if (!message) throw new Error('no_pending_message');
    this.store.transaction(() => {
      message.state = 'dispatching'; move(r, 'running', null, 'T10', now); this.store.put(r); stateEvent(this.store, r, 'waiting', now);
      this.store.activity(r, r.segment, 'mac.input', { input_id: message.id });
      this.store.db.prepare('INSERT INTO commands(run_id,segment,command_id,method,params) VALUES (?,?,?,?,?)')
        .run(r.id,r.segment,`input:${message.id}`,'run.input',JSON.stringify({ input_id: message.id, text: message.text }));
    });
    this.flushCommands(r);
  }
  private flushCommands(run: Run): void {
    if (run.stop || run.candidate || !['running','waiting'].includes(run.state)) return;
    for (const row of this.store.db.prepare('SELECT command_id,method,params FROM commands WHERE run_id=? AND segment=? AND delivered=0').all(run.id,run.segment)) {
      this.host.command(run.runDir,run.segment,{ kind:'rpc', id:row.command_id as string, method:row.method as string, params:JSON.parse(row.params as string) as Record<string, unknown> });
    }
  }
  flushPendingCommands(run: Run): void {
    this.flushCommands(run);
  }
  stop(id: string, kind: StopKind = 'cancel', now = Date.now(), preserveWip = false, reason: string | null = null): void {
    this.store.transaction(() => {
      this.stopInTransaction(id, kind, now, preserveWip, reason);
    });
  }
  stopInTransaction(id: string, kind: StopKind = 'cancel', now = Date.now(), preserveWip = false, reason: string | null = null): Run {
    const r = this.store.get(id);
    const processlessCancel = kind === 'cancel' && !preserveWip && r.state === 'waiting' && r.inputMode === 'resume' && !r.finalizing;
    requestStop(r, kind, now, preserveWip, reason); r.version++;
    this.store.emit('run.stop_requested', { stop_request: r.stop, version: r.version }, r, now);
    if (!['running','waiting'].includes(r.state) || processlessCancel) {
      const from = r.state; r.outputDrained = r.groupEmpty = true; this.finalizeRun(r, true, now); stateEvent(this.store, r, from, now);
      this.store.emit('run.result', { version: r.version, preservation: r.preservation, reason: r.reason }, r, now);
    }
    this.store.put(r);
    return r;
  }
  complete(id: string): void {
    const r = this.store.transaction(() => this.completeInTransaction(id));
    if (r.inputMode === 'stdin') this.flushCommands(r);
  }
  completeInTransaction(id: string): Run {
    const r = this.store.get(id);
    if (r.state !== 'waiting' || r.stop || r.finalizing) throw new Error('invalid_complete_state');
    if (r.inputMode === 'stdin') this.store.db.prepare('INSERT INTO commands(run_id,segment,command_id,method,params) VALUES (?,?,?,?,?)').run(r.id,r.segment,'complete','run.complete','{}');
    else recordCandidate(r, this.syntheticFinished('completed', null, r), Date.now(), 'host');
    r.finalizing = true; r.clocks.waitingSince = null;
    for (const m of r.messages) if (m.state === 'pending') m.state = 'invalidated';
    r.version++; this.store.put(r); this.store.emit('run.updated', { version: r.version, changes: { finalizing: true } }, r);
    return r;
  }
  private syntheticFinished(outcome: Finished['outcome'], code: string | null, r: Run): Finished {
    const usage = r.segmentUsage[r.segment] ?? emptyUsage();
    return { outcome, error: code ? { code } : null, work_started: true, final_message: null, usage, model: {}, reasoning_effort: {}, steps: usage.steps, turns: usage.turns, resume_token: null, native_session_id: null, native_exit: null };
  }
  async recover(): Promise<void> {
    for (const r of this.store.list()) {
      if (!['running','waiting'].includes(r.state)) continue;
      if (this.hostRestart) {
        if (r.state === 'waiting' && r.inputMode === 'resume' && !r.finalizing && !r.stop && !r.candidate) continue;
        // Host restart is modeled after all old processes are gone. No PID from a prior boot is signalled.
        const protocol = join(this.host.directory(r.runDir, r.segment), 'protocol.ndjson');
        if (r.segment && existsSync(protocol)) ingest(this.store, r.id, protocol);
        const recovered = this.store.get(r.id);
        this.store.transaction(() => {
          recovered.outputDrained = true; recovered.groupEmpty = true;
          this.store.emit('alert', { kind: 'host_restart', run_id: recovered.id }, recovered);
          if (!recovered.stop && !recovered.candidate) recordCandidate(recovered, this.syntheticFinished('failed', 'host_restart', recovered), Date.now(), 'host');
          if (candidateOutcome(recovered).state === 'waiting') {
            const from = recovered.state; this.finalizeRun(recovered); stateEvent(this.store, recovered, from, Date.now());
          }
          this.store.put(recovered);
        });
        if (recovered.state === 'waiting' && !recovered.stop && !recovered.candidate) continue;
        if (recovered.stop?.kind === 'cancel' && !recovered.stop.preserveWip) {
          this.store.transaction(() => { const from = recovered.state; this.finalizeRun(recovered); this.store.put(recovered); stateEvent(this.store, recovered, from, Date.now()); });
        } else await this.preserveAndFinalize(r.id, candidateOutcome(recovered).state === 'done' ? 'final' : 'wip');
        continue;
      }
      if (!r.intent || r.intent.status === 'ended') continue;
      const fence = this.host.fenceMissing(r.runDir, r.intent);
      const facts = this.host.facts(r.runDir, r.segment);
      if (fence === 'void' || this.host.isVoid(r.runDir, r.segment)) {
        this.store.transaction(() => {
          const from = r.state; r.intent!.status = 'void';
          if (r.launchAttempts >= 3) move(r, 'failed', 'launch_failed', 'T13');
          else { r.launchAttempts++; move(r, 'queued', 'launch_not_executed', 'T8'); }
          this.store.put(r); stateEvent(this.store, r, from, Date.now());
        });
      } else if (facts.shimAlive) {
        this.store.transaction(() => { r.intent!.status = 'spawned'; this.store.put(r); this.store.emit('alert', { kind: 'recovery', run_id: r.id }, r); });
        this.flushCommands(r);
      } else if (fence !== 'busy') {
        // Existing directory proves possible execution: never reissue this segment.
        await this.tickRun(r.id, 'recovery_failed');
      }
    }
  }
  private async preserveAndFinalize(id: string, kind: 'wip' | 'final', now = Date.now()): Promise<void> {
    let r = this.store.get(id);
    let result: Preservation;
    try { result = await this.options.preserve(r, kind); }
    catch (error) { result = { state: 'failed', kind, sha: null, error: String(error) }; }
    this.store.transaction(() => {
      r = this.store.get(id); const from = r.state; r.preservation = result;
      this.finalizeRun(r, true, now);
      this.store.put(r); stateEvent(this.store, r, from, now);
      this.store.emit('run.result', { version: r.version, preservation: result, reason: r.reason }, r);
      if (result.state === 'failed') this.store.emit('alert', { kind: 'preservation_failed', error: result.error }, r);
      if (kind === 'wip' && result.state === 'saved') this.store.activity(r, r.segment, 'mac.wip_committed', { sha: result.sha });
    });
  }
  async tick(now = Date.now()): Promise<void> {
    if (this.closed || this.ticking) throw new Error('runtime_closed_or_busy'); this.ticking = true;
    try {
      // Consume durable output first: an already committed candidate must win over a later clock check.
      for (const r of this.store.list()) if (!isTerminal(r.state) && r.state !== 'paused') await this.tickRun(r.id, 'runner_crash', now);
      for (const decision of decide(this.snapshot(), now)) {
        if (decision.action !== 'timeout' && decision.action !== 'pause_budget') continue;
        const r = this.store.get(decision.runId);
        const clock = Object.entries(this.deadlines(r)).find(([, at]) => at !== null && now >= at)?.[0] ?? 'total';
        this.stop(r.id, decision.action === 'timeout' ? 'timeout' : 'budget', now, false, decision.action === 'timeout' ? `timeout_${clock}` : null);
        if (['running','waiting'].includes(this.store.get(r.id).state)) await this.tickRun(r.id, 'runner_crash', now);
      }
    }
    finally { this.ticking = false; }
  }
  private async tickRun(id: string, crashCode = 'runner_crash', now = Date.now()): Promise<void> {
    let r = this.store.get(id);
    if (!['running','waiting'].includes(r.state) && !r.stop) return;
    const directory = this.host.directory(r.runDir, r.segment), path = join(directory, 'protocol.ndjson');
    if (r.segment && existsSync(path)) ingest(this.store, id, path, now);
    r = this.store.get(id);
    const facts = r.segment ? this.host.facts(r.runDir, r.segment) : { shimAlive: false, endpointAlive: false, groupAlive: false, outputDrained: true, status: null };
    if (facts.shimAlive && r.intent?.status === 'pending') this.store.transaction(() => { r.intent!.status = 'spawned'; this.store.put(r); });
    if (facts.shimAlive) this.flushCommands(r);
    if (!r.stop && !r.candidate && !r.protocolViolation && facts.shimAlive && !facts.status?.endpointExited) return;
    if (r.protocolViolation && !r.candidate) this.store.transaction(() => { recordCandidate(r, this.syntheticFinished('failed', 'protocol_violation', r), now, 'host'); this.store.put(r); });
    const ownsEndpoint = r.state === 'running' || (r.state === 'waiting' && r.inputMode === 'stdin');
    if (!facts.endpointAlive && (!facts.shimAlive || facts.status?.endpointExited) && ownsEndpoint && !r.candidate && !r.stop) {
      // A segment still being fenced/launched is reconciled by recover(), not treated as an immediate crash.
      if (!existsSync(directory) || (crashCode !== 'recovery_failed' && r.intent?.status === 'pending' && !this.host.launchRecord(r.runDir,r.segment))) return;
      this.store.transaction(() => { recordCandidate(r, this.syntheticFinished('failed', crashCode, r), now, 'host'); this.store.put(r); });
    }
    if (r.candidate || r.stop) {
      const cancel = facts.status?.cancel;
      if (r.stop && r.stop.sentAt === null && facts.status?.stopSentAt != null) {
        this.store.transaction(() => { r.stop!.sentAt = facts.status!.stopSentAt; this.store.activity(r, r.segment, 'mac.stop_sent', { at: r.stop!.sentAt }); this.store.put(r); });
      }
      const timing = cancel ? { ...this.timing, graceMs: cancel.grace_s * 1000 } : this.timing;
      const action = cleanupAction(r, now, facts.endpointAlive, facts.groupAlive, timing);
      if (r.stop && r.candidate?.source === 'runner' && facts.shimAlive) this.host.command(r.runDir, r.segment, { kind: 'close' });
      if (action === 'close_stdin' && facts.shimAlive) this.host.command(r.runDir, r.segment, { kind: 'close' });
      if (action === 'send_stop' || action === 'sigterm' || action === 'sigkill') {
        const control = action === 'send_stop' && cancel?.control_message && facts.shimAlive;
        if (control) this.host.command(r.runDir, r.segment, { kind: 'rpc', id: 'stop', method: 'run.cancel', params: {
          reason: ['cancel','pause'].includes(r.stop!.kind) ? 'supervisor' : r.stop!.kind, grace_s: cancel.grace_s } });
        else this.host.signal(r.runDir, r.segment, action === 'sigkill' ? 'SIGKILL' : 'SIGTERM');
        this.store.transaction(() => {
          if (action === 'send_stop' && !control) { r.stop!.sentAt = now; this.store.activity(r, r.segment, 'mac.stop_sent', { at: now }); }
          if (action === 'sigterm') { r.cleanupTermAt = now; if (r.candidate?.source === 'runner') r.protocolViolation = 'forced eviction after run.finished'; }
          this.store.put(r);
        });
      }
    }
    if (facts.groupAlive || facts.endpointAlive) return;
    let drained = facts.outputDrained;
    if (!facts.shimAlive && facts.status && existsSync(path)) {
      const repair = repairTail(directory, { shim: facts.status.shim, pgid: facts.status.pgid, boot: facts.status.boot });
      if (repair) {
        drained = true;
        if (repair.removed) this.store.transaction(() => this.store.diagnostic(id, 'tail_truncated', repair));
        ingest(this.store, id, path, now); r = this.store.get(id);
      }
    }
    if (!drained && !facts.status && existsSync(directory) && crashCode === 'recovery_failed') drained = true;
    if (!drained || (!r.candidate && !r.stop)) return;
    if (!r.stop && !r.protocolViolation && r.candidate && environmentFailure(r.candidate.data)) {
      const current = workspaceState(r.workspace);
      if (noWorkProduced(r.candidate.data, { toolOrFileEvent: r.hadWorkEvents,
        headUnchanged: r.workspaceHead === null || current.head === null ? null : r.workspaceHead === current.head, clean: current.clean })) {
        this.store.transaction(() => {
          const from = r.state;
          if (r.launchAttempts >= 3) move(r, 'failed', 'launch_failed', 'T13', now);
          else { r.launchAttempts++; move(r, 'queued', 'launch_no_work', 'T8', now); }
          r.finalizing = false; r.candidate = null; if (r.intent) r.intent.status = 'ended';
          this.store.put(r); stateEvent(this.store, r, from, now);
        }); return;
      }
    }
    const choice = candidateOutcome(r);
    this.store.transaction(() => {
      r.outputDrained = true; r.groupEmpty = true;
      if (choice.state === 'waiting') { const from = r.state; this.finalizeRun(r, true, now); this.store.put(r); stateEvent(this.store, r, from, now); }
      else {
        r.finalizing = true; r.preservation = { state: 'pending', kind: choice.state === 'done' ? 'final' : 'wip', error: null, sha: null }; this.store.put(r);
      }
    });
    if (choice.state === 'waiting') return;
    if (r.segment === 0 || (r.stop?.kind === 'cancel' && !r.stop.preserveWip)) {
      this.store.transaction(() => { const from = r.state; r.preservation = { state: 'not_required', kind: null, error: null, sha: null }; this.finalizeRun(r, true, now); this.store.put(r); stateEvent(this.store, r, from, now); }); return;
    }
    await this.preserveAndFinalize(id, choice.state === 'done' ? 'final' : 'wip', now);
  }
  close(): void { if (!this.closed) { this.closed = true; this.store.close(); this.release(); } }
}
