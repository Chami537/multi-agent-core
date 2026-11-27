import { emptyUsage, type Run, type Usage } from './types.js';

export const counters = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'steps', 'turns', 'native_cost_usd'] as const;
// Segment receipts remain untouched. Unknown counters do not erase known subtotals.
export function aggregateUsage(segments: Readonly<Record<string, Usage>>): Run['usage'] {
  const members = Object.values(segments), result: Run['usage'] = { ...emptyUsage(), unknown_runs: 0 };
  if (!members.length) return result;
  for (const key of counters) {
    const known = members.map(u => u[key]).filter((n): n is number => n !== null);
    result[key] = known.length ? known.reduce((a, b) => a + b, 0) : null;
  }
  result.unknown_runs = members.filter(u => u.completeness !== 'exact' || counters.some(k => k !== 'native_cost_usd' && u[k] === null)).length;
  result.completeness = members.every(u => u.completeness === 'exact') ? 'exact' : members.every(u => u.completeness === 'unknown') ? 'unknown' : 'partial';
  const first = members[0]!;
  result.basis = { native_scope: members.every(u => u.basis.native_scope === first.basis.native_scope) ? first.basis.native_scope : 'unknown',
    aggregation: 'cumulative', cache_in_input: members.every(u => u.basis.cache_in_input === first.basis.cache_in_input) ? first.basis.cache_in_input : null,
    source: members.every(u => u.basis.source === first.basis.source) ? first.basis.source : null };
  for (const key of new Set(members.flatMap(u => Object.keys(u.extra)))) {
    const values = members.map(u => u.extra[key]).filter((n): n is number => typeof n === 'number');
    if (values.length) result.extra[key] = values.reduce((a, b) => a + b, 0);
  }
  return result;
}
