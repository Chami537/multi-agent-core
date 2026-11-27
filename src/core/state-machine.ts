import { terminal, type InputMode, type State } from './types.js';

const nonterminal: State[] = ['queued', 'blocked', 'held', 'leasing', 'running', 'waiting', 'paused'];
interface Transition { id: string; from: (State | null)[]; to: State }
// T17 was removed by protocol 0.2. Keep its number vacant.
export const transitions: readonly Transition[] = [
  { id: 'T1', from: [null], to: 'queued' }, { id: 'T2', from: [null], to: 'blocked' },
  { id: 'T3', from: ['blocked'], to: 'queued' }, { id: 'T4', from: ['queued'], to: 'leasing' },
  { id: 'T5', from: ['queued', 'leasing'], to: 'running' },
  { id: 'T6', from: ['queued', 'leasing'], to: 'held' }, { id: 'T7', from: ['held'], to: 'queued' },
  { id: 'T8', from: ['running'], to: 'queued' }, { id: 'T9', from: ['running'], to: 'waiting' },
  { id: 'T10', from: ['waiting'], to: 'running' }, { id: 'T11', from: ['running'], to: 'done' },
  { id: 'T12', from: ['waiting'], to: 'done' }, { id: 'T13', from: ['running', 'waiting', 'queued', 'leasing'], to: 'failed' },
  { id: 'T14', from: ['running', 'waiting'], to: 'interrupted' },
  { id: 'T15', from: ['running', 'waiting'], to: 'paused' },
  { id: 'T16', from: ['queued', 'blocked', 'held', 'leasing'], to: 'paused' },
  { id: 'T18', from: ['paused'], to: 'interrupted' }, { id: 'T19', from: nonterminal, to: 'cancelled' },
  { id: 'T20', from: ['queued', 'held'], to: 'blocked' }, { id: 'T21', from: ['blocked'], to: 'held' },
  { id: 'T22', from: [null], to: 'held' },
];
export function assertTransition(from: State | null, to: State, id?: string): string {
  const t = transitions.find(t => t.from.includes(from) && t.to === to && (!id || t.id === id));
  if (!t) throw new Error(`invalid_transition: ${from} -> ${to}${id ? ` (${id})` : ''}`);
  return t.id;
}
export function homeState(dependencies: readonly State[], legalTarget: boolean): State {
  return dependencies.some(d => d !== 'done') ? 'blocked' : legalTarget ? 'queued' : 'held';
}
export function occupiesSlot(run: { state: State; inputMode: InputMode }): boolean {
  return run.state === 'running' || (run.state === 'waiting' && run.inputMode === 'stdin');
}
export function isTerminal(state: State): boolean { return terminal.has(state); }
