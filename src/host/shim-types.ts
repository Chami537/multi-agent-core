import type { StartParams } from '../core/types.js';
import type { Identity } from './process.js';
export interface ShimRequest {
  runDir: string; segment: number; token: string; command: string[]; cwd: string;
  env: Record<string, string>; start: StartParams;
}
export interface LaunchRecord { token: string; shim: Identity; boot: string; createdAt: number }
export interface ShimStatus {
  shim: Identity; endpoint: Identity | null; pgid: number | null; boot: string;
  outputDrained: boolean; endpointExited: boolean; code: number | null; signal: string | null; error: string | null;
}
export type ShimCommand = { kind: 'rpc'; id?: string; method: string; params: Record<string, unknown> } | { kind: 'close' };
