import { assertTransition, occupiesSlot } from './state-machine.js';
import type { Finished, Run, State, StopKind } from './types.js';

export interface Timing { exitMs: number; killMs: number; graceMs: number }
export const defaultTiming: Timing = { exitMs: 10_000, killMs: 5_000, graceMs: 10_000 };
export class InvalidState extends Error {
  readonly code = 'invalid_state';
  constructor(readonly phase: string) { super(`invalid_state: ${phase}`); }
}
export function move(run: Run, to: State, reason: string | null, transition?: string): void {
  assertTransition(run.state, to, transition);
  run.state = to; run.reason = reason; run.version++; run.reservation = occupiesSlot(run);
}
export function requestStop(run: Run, kind: StopKind, now: number, preserveWip = true): 'accepted' | 'queued' {
  if (['done', 'failed', 'cancelled', 'interrupted'].includes(run.state)) throw new InvalidState('terminal');
  if (!run.stop && run.candidate && run.candidate.data.outcome !== 'awaiting_input') throw new InvalidState('finalizing');
  if (!run.stop || (kind === 'cancel' && run.stop.kind !== 'cancel')) {
    // Keep the original sentAt: upgrading pause to cancel must not extend the grace period.
    run.stop = { kind, requestedAt: now, linearizedAt: run.stop?.linearizedAt ?? now, sentAt: run.stop?.sentAt ?? null, preserveWip };
  }
  for (const m of run.messages) if (m.state === 'pending') m.state = 'invalidated';
  run.finalizing = true;
  return run.candidate?.data.outcome === 'awaiting_input' ? 'queued' : 'accepted';
}
export function recordCandidate(run: Run, data: Finished, now: number): void {
  if (run.candidate) { run.protocolViolation = 'multiple run.finished'; return; }
  run.candidate = { data, at: now, stopPrecedes: run.stop !== null }; run.finalizing = true; run.resumeToken = data.resume_token;
}
export type CleanupAction = 'none' | 'close_stdin' | 'send_stop' | 'sigterm' | 'sigkill';
// Logical outcome and physical eviction are independent. All times are host commit/send times.
export function cleanupAction(run: Run, now: number, endpointAlive: boolean, groupAlive: boolean, timing: Timing = defaultTiming): CleanupAction {
  if (!groupAlive) return 'none';
  const stopFirst = run.stop && (!run.candidate || run.candidate.stopPrecedes);
  if (stopFirst) {
    if (run.stop!.sentAt === null) return 'send_stop';
    return now >= run.stop!.sentAt + timing.graceMs + timing.killMs ? 'sigkill' : 'none';
  }
  if (!run.candidate) return 'none';
  if (run.cleanupTermAt !== null) return now >= run.cleanupTermAt + timing.killMs ? 'sigkill' : 'none';
  if (!endpointAlive || now >= run.candidate.at + timing.exitMs) return 'sigterm';
  return 'close_stdin';
}
export function candidateOutcome(run: Run): { state: State; reason: string } {
  const stopFirst = run.stop && (!run.candidate || run.candidate.stopPrecedes);
  if (stopFirst) {
    if (run.stop!.kind === 'cancel') return { state: 'cancelled', reason: 'supervisor_cancel' };
    return run.stop!.kind === 'timeout' ? { state: 'interrupted', reason: 'timeout_total' }
      : { state: 'paused', reason: { pause: 'supervisor_pause', guard: 'memory_limit', budget: 'budget_exceeded' }[run.stop!.kind] ?? 'supervisor_pause' };
  }
  if (run.protocolViolation) return { state: 'failed', reason: 'protocol_violation' };
  const d = run.candidate?.data;
  if (!d) return { state: 'interrupted', reason: 'runner_crash' };
  if (d.outcome === 'awaiting_input') return { state: 'waiting', reason: 'awaiting_input' };
  if (d.outcome === 'completed') return { state: 'done', reason: 'completed' };
  if (d.outcome === 'cancelled') return { state: 'interrupted', reason: 'runner_crash' };
  const code = d.error?.code ?? 'runner_internal';
  if (code === 'step_limit_reached') return { state: 'paused', reason: code };
  if (['runner_crash', 'recovery_failed', 'auth_failed', 'gateway_unavailable', 'quota_exhausted', 'upstream_unavailable', 'region_restricted'].includes(code)) return { state: 'interrupted', reason: code };
  return { state: 'failed', reason: code };
}
export function finalize(run: Run, deliverablesValid = true): void {
  if (!run.outputDrained || !run.groupEmpty) throw new Error('finalization_not_drained');
  const choice = candidateOutcome(run);
  if (choice.state === 'waiting') {
    move(run, 'waiting', choice.reason); run.candidate = null; run.finalizing = !!run.stop;
    if (run.intent) run.intent.status = 'ended';
    return;
  }
  if (run.preservation.state === 'pending') throw new Error('preservation_pending');
  if (run.preservation.state === 'failed') {
    run.protected = true;
    choice.reason = 'preservation_failed';
    if (choice.state !== 'cancelled') choice.state = choice.state === 'done' ? 'failed' : 'interrupted';
  } else if (choice.state === 'done' && !deliverablesValid) { choice.state = 'failed'; choice.reason = 'deliverable_invalid'; }
  move(run, choice.state, choice.reason); run.finalizing = false;
  if (run.intent) run.intent.status = 'ended';
}
