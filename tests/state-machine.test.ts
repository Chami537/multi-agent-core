import { describe, expect, it } from 'vitest';
import { assertTransition, homeState, transitions } from '../dist/core/state-machine.js';

describe('S 9.2 transition table', () => {
  it.each(transitions.map(t => [t.id, t] as const))('%s permits exactly its declared edges', (_id, t) => {
    for (const from of t.from) expect(assertTransition(from, t.to, t.id)).toBe(t.id);
  });
  it.each([
    ['done','running'], ['failed','queued'], ['paused','queued'], ['paused','running'],
    ['held','failed'], ['blocked','done'], ['leasing','blocked'], ['waiting','queued'], ['cancelled','done'],
  ] as const)('rejects %s -> %s', (from, to) => expect(() => assertTransition(from, to)).toThrow('invalid_transition'));
  it('T17 stays vacant', () => expect(() => assertTransition('paused','queued','T17')).toThrow());
  it('T20-T22 follow dependency-first homing', () => {
    expect(homeState(['failed'], false)).toBe('blocked');
    expect(homeState(['done'], false)).toBe('held'); expect(homeState([], true)).toBe('queued');
    expect(assertTransition('held', homeState(['running'], false))).toBe('T20');
    expect(assertTransition('blocked', homeState(['done'], false))).toBe('T21');
    expect(assertTransition(null, homeState([], false))).toBe('T22');
  });
});
