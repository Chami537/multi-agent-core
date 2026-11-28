import type { Finished } from './types.js';
export interface WorkProof { toolOrFileEvent: boolean; headUnchanged: boolean | null; clean: boolean | null }
// R 13.4 is deliberately conservative: an unknown fact never authorizes a retry.
export function noWorkProduced(finished: Finished, proof: WorkProof): boolean {
  return !finished.work_started && !proof.toolOrFileEvent && proof.headUnchanged === true && proof.clean === true;
}
export function environmentFailure(finished: Finished): boolean {
  return finished.outcome === 'failed' && ['auth_failed','gateway_unavailable','quota_exhausted','upstream_unavailable','region_restricted','rate_limited','service_unavailable'].includes(finished.error?.code ?? '');
}

// One source for the exact value sent to the fake runner and exposed in the ledger.
export function nativeEffort(effort: string): string | null {
  return ({ low: 'l', medium: 'm', high: 'h' } as Record<string, string>)[effort] ?? null;
}
