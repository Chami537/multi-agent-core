import { afterEach, describe, expect, it } from 'vitest';
import { candidateOutcome, cleanupAction, defaultTiming, finalize, recordCandidate, requestStop } from '../dist/core/lifecycle.js';
import { emptyUsage, type Finished, type Run } from '../dist/core/types.js';
import { cleanup, makeRuntime, workspace } from './helpers/runtime.js';
function run(): Run { const rt = makeRuntime(); const r = rt.create({ workspace: workspace(rt) }); r.state = 'running'; r.reservation = true; return r; }
function finished(outcome: Finished['outcome'] = 'completed'): Finished {
  return { outcome, error: null, work_started: true, final_message: 'ok', usage: emptyUsage(), steps: 1, turns: 1, resume_token: null, native_exit: null, native_session_id: null, model: {}, reasoning_effort: {} };
}
afterEach(cleanup);
describe('logical race and physical eviction', () => {
  it('first committed stop wins; explicit cancel upgrades without resetting sent time', () => {
    const r = run(); requestStop(r, 'pause', 1); r.stop!.sentAt = 2; recordCandidate(r, finished(), 3); requestStop(r, 'cancel', 4);
    expect(r.stop?.sentAt).toBe(2); expect(candidateOutcome(r).state).toBe('cancelled');
  });
  it.each(['completed','failed'] as const)('%s candidate rejects later stop', outcome => {
    const r = run(); recordCandidate(r, finished(outcome), 1); expect(() => requestStop(r,'cancel',2)).toThrow('finalizing');
    expect(cleanupAction(r,10_001,true,true)).toBe('sigterm');
  });
  it('awaiting-input queues stop until waiting is committed', () => {
    const r = run(); r.inputMode = 'resume'; recordCandidate(r, finished('awaiting_input'), 1); expect(requestStop(r, 'pause', 2)).toBe('queued');
    r.outputDrained = r.groupEmpty = true; finalize(r); expect(r.state).toBe('waiting'); expect(r.reservation).toBe(false);
    expect(candidateOutcome(r).state).toBe('paused'); finalize(r); expect(r.state).toBe('paused');
  });
  it('uses commit order even when timestamps coincide or wall clock moves backwards', () => {
    const r=run(); r.inputMode='resume'; recordCandidate(r,finished('awaiting_input'),100); requestStop(r,'pause',100);
    expect(candidateOutcome(r).state).toBe('waiting');
    const other=run(); requestStop(other,'cancel',100); recordCandidate(other,finished(),50); expect(candidateOutcome(other).state).toBe('cancelled');
  });
  it('candidate keeps capacity through drain, group exit and preservation', () => {
    const r = run(); recordCandidate(r, finished(),1); expect(r.reservation).toBe(true); expect(() => finalize(r)).toThrow('drained');
    r.outputDrained = r.groupEmpty = true; r.preservation.state = 'pending'; expect(() => finalize(r)).toThrow('pending');
    r.preservation.state = 'saved'; finalize(r); expect(r.state).toBe('done'); expect(r.reservation).toBe(false); expect(() => finalize(r)).toThrow();
  });
  it('live endpoint waits the full 10s before TERM, then 5s before KILL', () => {
    const r = run(); recordCandidate(r, finished(),100); expect(defaultTiming.exitMs).toBe(10_000); expect(defaultTiming.killMs).toBe(5_000);
    expect(cleanupAction(r,10_099,true,true)).toBe('close_stdin'); expect(cleanupAction(r,10_100,true,true)).toBe('sigterm');
    r.cleanupTermAt=10_100; expect(cleanupAction(r,15_099,true,true)).toBe('none'); expect(cleanupAction(r,15_100,true,true)).toBe('sigkill');
  });
  it('exited endpoint with descendants gets immediate TERM before the 10s deadline', () => {
    const r=run(); recordCandidate(r,finished(),100); expect(cleanupAction(r,101,false,true)).toBe('sigterm'); expect(cleanupAction(r,101,false,false)).toBe('none');
  });
  it('stop escalation starts at actual signal send, not requestedAt', () => {
    const r=run(); requestStop(r,'cancel',1); expect(cleanupAction(r,20_000,true,true)).toBe('send_stop'); r.stop!.sentAt=20_000;
    expect(cleanupAction(r,34_999,true,true)).toBe('none'); expect(cleanupAction(r,35_000,true,true)).toBe('sigkill');
  });
  it.each([['done','failed'],['paused','interrupted'],['cancelled','cancelled']] as const)('preservation failure maps %s to %s', (wanted, expected) => {
    const r=run(); if(wanted==='done') recordCandidate(r,finished(),1); else requestStop(r,wanted==='paused'?'pause':'cancel',1);
    r.outputDrained=r.groupEmpty=true; r.preservation={ state:'failed', kind:'wip', error:'disk full', sha:null }; finalize(r);
    expect(r.state).toBe(expected); expect(r.reason).toBe('preservation_failed'); expect(r.protected).toBe(true);
  });
  it('tail protocol violation overrides a successful candidate before terminal commit', () => {
    const r=run(); recordCandidate(r,finished(),1); r.protocolViolation='trailing output'; r.outputDrained=r.groupEmpty=true; finalize(r); expect(r.state).toBe('failed'); expect(r.reason).toBe('protocol_violation');
  });
});
