import { afterEach, describe, expect, it } from 'vitest';
import { emptyUsage, type RunnerEvent } from '../dist/core/types.js';
import { aggregateUsage } from '../dist/core/usage.js';
import { applyEvent } from '../dist/core/reducer.js';
import { move } from '../dist/core/lifecycle.js';
import { cleanup, makeRuntime, workspace } from './helpers/runtime.js';

afterEach(cleanup);
describe('segment aggregation and active clocks', () => {
  it('adds known counters, records unknown members and keeps segment receipts untouched', () => {
    const a = { ...emptyUsage(), input_tokens: 100, output_tokens: null, steps: 2, completeness: 'exact' as const, extra: { reasoning_tokens: 5 }, basis: { ...emptyUsage().basis, cache_in_input: true } };
    const b = { ...emptyUsage(), input_tokens: 7, output_tokens: 3, steps: 1, completeness: 'partial' as const, extra: { reasoning_tokens: 2 }, basis: { ...emptyUsage().basis, cache_in_input: false } };
    const segments = { 1: a, 2: b }, before = structuredClone(segments), result = aggregateUsage(segments);
    expect(result).toMatchObject({ input_tokens: 107, output_tokens: 3, steps: 3, cache_write_tokens: null, completeness: 'partial', unknown_runs: 2, extra: { reasoning_tokens: 7 }, basis: { cache_in_input: null } });
    expect(segments).toEqual(before);
    expect(aggregateUsage({ 1: emptyUsage(), 2: emptyUsage() })).toMatchObject({ input_tokens: null, completeness: 'unknown', unknown_runs: 2 });
  });
  it('compares cumulative usage against its own segment, never the run aggregate', () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt) }); r.segment = 2;
    r.previousSteps = 1; r.segmentUsage['1'] = { ...emptyUsage(), input_tokens: 100, steps: 1 }; r.usage = aggregateUsage(r.segmentUsage);
    const event = (value: number): RunnerEvent => ({ seq: 1, ts: '', type: 'usage', data: { ...emptyUsage(), input_tokens: value, steps: 1 } });
    applyEvent(r, event(7), 0); expect(r.usage.input_tokens).toBe(107); applyEvent(r, event(8), 1); expect(r.usage.input_tokens).toBe(108);
    expect(() => applyEvent(r, event(6), 2)).toThrow('usage_regressed');
  });
  it('idle clock ignores logs, errors, limit notices and unchanged usage', () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt) }); move(r, 'running', null, 'T5', 0); r.segment = 1;
    const event = (type: string, data = {}): RunnerEvent => ({ seq: 1, ts: '', type, data });
    for (const type of ['log', 'error', 'limit.notice']) applyEvent(r, event(type), 100);
    expect(r.clocks.idleSince).toBe(0); applyEvent(r, event('message'), 200); expect(r.clocks.idleSince).toBe(200);
    const usage = { ...emptyUsage(), steps: 1 }; applyEvent(r, event('usage', usage), 300); expect(r.clocks.idleSince).toBe(300);
    applyEvent(r, event('usage', usage), 400); expect(r.clocks.idleSince).toBe(300);
    r.inputMode = 'stdin'; applyEvent(r, event('input.requested'), 500); expect(r.clocks.idleSince).toBeNull(); expect(r.clocks.waitingSince).toBe(500);
  });
  it('total counts only running spans and idle starts afresh when stdin returns', () => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), inputMode: 'stdin' });
    move(r, 'running', null, 'T5', 100); move(r, 'waiting', 'awaiting_input', 'T9', 300);
    expect(r.clocks).toEqual({ totalMs: 200, runningSince: null, idleSince: null, waitingSince: 300 });
    move(r, 'running', null, 'T10', 10_000); expect(r.clocks.totalMs).toBe(200); expect(r.clocks.idleSince).toBe(10_000);
    move(r, 'queued', 'launch_no_work', 'T8', 10_050); expect(r.clocks.totalMs).toBe(250);
    move(r, 'running', null, 'T5', 100_000); expect(r.clocks.totalMs).toBe(250);
  });
});
