import { occupiesSlot } from './state-machine.js';
import type { InputMode, LaunchIntent, State } from './types.js';

export interface SchedulingRun {
  id: string; state: State; inputMode: InputMode; reservation: boolean; projectId: string; account: string;
  intent: LaunchIntent | null; intentConfirmed: boolean; shimAlive: boolean; groupAlive: boolean;
  pendingMessages: number; lease: 'none' | 'waiting' | 'acquired'; budgetRemaining: boolean;
  deadlines: { total: number | null; idle: number | null; waiting: number | null };
  finalizing: boolean; stopping: boolean;
}
export interface Snapshot {
  runs: readonly SchedulingRun[]; globalLimit: number;
  projectLimits: Readonly<Record<string, number>>;
  accounts: Readonly<Record<string, { limit: number; healthy: boolean; frozenUntil: number | null }>>;
}
export type Decision = { runId: string; action: 'start' | 'deliver_input' | 'acquire_lease' | 'pause_budget' | 'timeout' | 'recover_launch' };
// All capacity is a durable reservation. Process liveness never frees a slot.
export function decide(snapshot: Snapshot, now: number): Decision[] {
  const usedProjects: Record<string, number> = {}, usedAccounts: Record<string, number> = {};
  let used = 0;
  for (const r of snapshot.runs) {
    if (r.reservation !== occupiesSlot(r)) throw new Error(`invalid_reservation: ${r.id}`);
    if (r.reservation) { used++; usedProjects[r.projectId] = (usedProjects[r.projectId] ?? 0) + 1; usedAccounts[r.account] = (usedAccounts[r.account] ?? 0) + 1; }
  }
  const result: Decision[] = [];
  for (const r of snapshot.runs) {
    const emit = (action: Decision['action']) => result.push({ runId: r.id, action });
    if (r.finalizing || r.stopping) continue;
    if (r.state === 'running' || r.state === 'waiting') {
      if (Object.values(r.deadlines).some(t => t !== null && now >= t)) { emit('timeout'); continue; }
      if (r.state === 'running' && r.intent && (!r.intentConfirmed || !r.shimAlive)) { emit('recover_launch'); continue; }
    }
    const resume = r.state === 'waiting' && r.pendingMessages > 0;
    if (r.state !== 'queued' && r.state !== 'leasing' && !resume) continue;
    if (!r.budgetRemaining) { emit('pause_budget'); continue; }
    if (resume && r.inputMode === 'stdin') { emit('deliver_input'); continue; }
    const account = snapshot.accounts[r.account];
    if (!account || !account.healthy || (account.frozenUntil !== null && now < account.frozenUntil)) continue;
    if (r.lease === 'waiting') { if (r.state === 'queued') emit('acquire_lease'); continue; }
    if (used >= snapshot.globalLimit || (usedProjects[r.projectId] ?? 0) >= (snapshot.projectLimits[r.projectId] ?? snapshot.globalLimit)
      || (usedAccounts[r.account] ?? 0) >= account.limit) continue;
    emit(resume ? 'deliver_input' : 'start');
    used++; usedProjects[r.projectId] = (usedProjects[r.projectId] ?? 0) + 1; usedAccounts[r.account] = (usedAccounts[r.account] ?? 0) + 1;
  }
  return result;
}
