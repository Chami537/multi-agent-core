export type State = 'queued' | 'blocked' | 'held' | 'leasing' | 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export const terminal = new Set<State>(['done', 'failed', 'cancelled', 'interrupted']);
export type InputMode = 'none' | 'stdin' | 'resume';
export type Role = 'dev' | 'design' | 'review' | 'audit' | 'integrate';
export type StopKind = 'cancel' | 'pause' | 'timeout' | 'guard' | 'budget';
export interface StopRequest { kind: StopKind; requestedAt: number; linearizedAt: number; sentAt: number | null; preserveWip: boolean }
export interface Usage {
  input_tokens: number | null; output_tokens: number | null;
  cache_read_tokens: number | null; cache_write_tokens: number | null;
  steps: number | null; turns: number | null; completeness: 'exact' | 'partial' | 'unknown';
  extra: Record<string, unknown>; native_cost_usd: number | null;
  basis: { native_scope: 'segment' | 'session' | 'unknown'; aggregation: 'cumulative'; cache_in_input: boolean | null; source: string | null };
  native_cumulative: Record<string, unknown> | null;
}
export function emptyUsage(): Usage {
  return { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
    steps: null, turns: null, completeness: 'unknown', extra: {}, native_cost_usd: null,
    basis: { native_scope: 'unknown', aggregation: 'cumulative', cache_in_input: null, source: null }, native_cumulative: null };
}
export type Outcome = 'completed' | 'awaiting_input' | 'failed' | 'cancelled';
export interface Finished {
  outcome: Outcome; error: { code: string; [key: string]: unknown } | null;
  work_started: boolean; final_message: string | null; usage: Usage;
  model: Record<string, unknown>; reasoning_effort: Record<string, unknown>;
  steps: number | null; turns: number | null; resume_token: string | null;
  native_session_id: string | null; native_exit: { code: number | null; signal: string | null } | null;
}
export interface Candidate { at: number; stopPrecedes: boolean; data: Finished }
export interface Preservation { state: 'not_required' | 'pending' | 'saved' | 'failed'; kind: 'wip' | 'final' | null; error: string | null; sha: string | null }
export interface LaunchIntent {
  runId: string; segment: number; segmentKind: 'initial' | 'launch_retry' | 'resume';
  launchToken: string; daemonEpoch: number; status: 'pending' | 'spawned' | 'void' | 'ended';
}
export interface Message { id: string; text: string; state: 'pending' | 'dispatching' | 'delivered' | 'invalidated' }
export interface Run {
  id: string; projectId: string; taskId: string; account: string; runner: 'fake';
  state: State; reason: string | null; version: number; inputMode: InputMode;
  role: Role; model: string; reasoningEffort: string; reservation: boolean;
  segment: number; launchAttempts: number; intent: LaunchIntent | null;
  finalizing: boolean; stop: StopRequest | null; candidate: Candidate | null;
  usage: Usage; previousSteps: number; protocolViolation: string | null;
  preservation: Preservation; protected: boolean; messages: Message[]; resumeToken: string | null;
  cleanupTermAt: number | null; outputDrained: boolean; groupEmpty: boolean;
  workspaceHead: string | null; hadWorkEvents: boolean;
  workspace: string; runDir: string; prompt: string; maxSteps: number | null;
}
export interface RunnerEvent { seq: number; ts: string; type: string; data: Record<string, unknown> }
export interface StartParams {
  run_id: string; segment: number; prompt: { text: string; format: 'markdown' };
  model: { id: string }; reasoning_effort: { effort: string; native: string | null };
  interaction: 'autonomous' | 'interactive';
  workspace: { cwd: string; read_only: boolean; artifacts_dir: string; scratch_dir: string; readonly_paths: string[] };
  limits: { max_steps: number | null; total_s: number | null; idle_s: number | null };
  forbidden: string[]; resume: { token: string; input: { input_id: string; text: string }; usage_baseline: Record<string, unknown> | null } | null;
  raw_dir: null; conformance: { scenario: unknown } | null;
}
