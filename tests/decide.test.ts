import { describe, expect, it } from 'vitest';
import { decide, type SchedulingRun, type Snapshot } from '../dist/core/decide.js';
function run(id: string, changes: Partial<SchedulingRun> = {}): SchedulingRun {
  return { id, state: 'queued', inputMode: 'none', reservation: false, projectId: 'p', account: 'a', intent: null,
    intentConfirmed: false, shimAlive: false, groupAlive: false, pendingMessages: 0, lease: 'none', budgetRemaining: true,
    deadlines: { total: null, idle: null, waiting: null }, finalizing: false, stopping: false, ...changes };
}
function snapshot(runs: SchedulingRun[], changes: Partial<Snapshot> = {}): Snapshot {
  return { runs, globalLimit: 1, projectLimits: {}, accounts: { a: { limit: 1, healthy: true, frozenUntil: null } }, ...changes };
}
describe('decide(snapshot, now)', () => {
  it('reserves all choices within the same decision and is pure', () => {
    const s = snapshot([run('a'),run('b')]); const before = JSON.stringify(s);
    expect(decide(s, 0)).toEqual([{ runId: 'a', action: 'start' }]); expect(JSON.stringify(s)).toBe(before); expect(decide(s, 0)).toEqual(decide(s,0));
  });
  it.each([
    { state: 'running', inputMode: 'none', reservation: true, shimAlive: false, groupAlive: false },
    { state: 'running', inputMode: 'none', reservation: true, finalizing: true },
    { state: 'waiting', inputMode: 'stdin', reservation: true },
  ] as const)('counts reservations independent of liveness: %j', changes => {
    expect(decide(snapshot([run('busy', changes),run('new')]), 0)).toEqual([]);
  });
  it('resume waiting and lease wait consume no capacity', () => {
    expect(decide(snapshot([run('wait', { state: 'waiting', inputMode: 'resume' }), run('lease', { state: 'leasing', lease: 'waiting' }), run('new')]), 0)).toEqual([{ runId: 'new', action: 'start' }]);
  });
  it('stdin input uses its existing reservation even after hot downscale', () => {
    expect(decide(snapshot([run('w', { state: 'waiting', inputMode: 'stdin', reservation: true, pendingMessages: 1 })], { globalLimit: 0 }), 0)).toEqual([{ runId: 'w', action: 'deliver_input' }]);
  });
  it('resume input waits for capacity', () => {
    const s = snapshot([run('busy', { state: 'running', reservation: true }),run('w', { state: 'waiting', inputMode: 'resume', pendingMessages: 1 })]);
    expect(decide(s, 0)).toEqual([]); expect(decide({ ...s, globalLimit: 2, accounts: { a: { limit: 2, healthy: true, frozenUntil: null } } },0)).toEqual([{ runId: 'w', action: 'deliver_input' }]);
  });
  it('checks project and account capacity separately', () => {
    const s = snapshot([run('a'),run('b'),run('c', { projectId: 'q', account: 'b' })], { globalLimit: 4, projectLimits: { p: 1 }, accounts: { a: { limit: 3, healthy: true, frozenUntil: null }, b: { limit: 1, healthy: true, frozenUntil: null } } });
    expect(decide(s, 0).map(d => d.runId)).toEqual(['a','c']);
  });
  it('uses the snapshot clock for account cooldown', () => {
    const s = snapshot([run('q')], { accounts: { a: { limit: 1, healthy: true, frozenUntil: 100 } } }); expect(decide(s,99)).toEqual([]); expect(decide(s,100)).toHaveLength(1);
  });
  it('does not deliver input after budget exhaustion', () => {
    expect(decide(snapshot([run('w', { state: 'waiting', inputMode: 'stdin', reservation: true, pendingMessages: 1, budgetRemaining: false })]),0)).toEqual([{ runId: 'w', action: 'pause_budget' }]);
  });
  it('checks lease and clock facts, never wall clock', () => {
    expect(decide(snapshot([run('l', { lease: 'waiting' })]),0)).toEqual([{ runId: 'l', action: 'acquire_lease' }]);
    expect(decide(snapshot([run('r', { state: 'running', reservation: true, deadlines: { total: 50, idle: null, waiting: null } })]),50)).toEqual([{ runId:'r', action:'timeout' }]);
  });
  it('refuses inconsistent durable reservations', () => expect(() => decide(snapshot([run('r',{ state:'running' })]),0)).toThrow('invalid_reservation'));
});
