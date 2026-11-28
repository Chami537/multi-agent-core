import type { Runtime } from '../core/runtime.js';
import type { Role } from '../core/types.js';

export type Scope = 'read' | 'submit' | 'control' | 'decide' | 'admin';
export type Level = 'L1' | 'L2' | 'L3' | 'L4';
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'default';
export type Tier = 'low' | 'mid' | 'high';

export const PROTOCOL_VERSION = '0.2';
export const SUPPORTED_VERSIONS = ['0.2'] as const;

export const L4_ACTIONS = ['push', 'write_base_branch', 'deploy', 'modify_secrets'] as const;

export const VOCABULARY = {
  tiers: ['low', 'mid', 'high'] as const,
  effort_ladder: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const,
  effort_special: ['default'] as const,
  roles: ['dev', 'review', 'audit', 'design', 'integrate'] as const,
  levels: ['L1', 'L2', 'L3', 'L4'] as const,
  l4_actions: L4_ACTIONS,
  forbidden_actions: ['push', 'write_base_branch', 'deploy', 'modify_secrets', 'install_deps', 'network', 'write_outside_workspace'] as const,
  degradable_capabilities: ['read_only', 'max_steps'] as const,
  waivable_rules: ['REVIEW_SAME_RUNNER'] as const,
};

export interface TokenConfig {
  token?: string;
  tokenHash?: string;
  token_id: string;
  principal: string;
  scopes: Scope[];
  projects: string[];
  expires_at?: string | null;
  rate_limit?: {
    requests_per_s: number;
    burst: number;
    runs_per_min: number;
    sse_connections: number;
  };
}

export interface ProjectConfig {
  id: string;
  name: string;
  default_branch: string;
  workspace_path: string;
  max_level: Level;
  forbidden: { action: string; enforcement: 'dispatch' | 'runtime' }[];
  acceptance?: { command: string; env: Record<string, string> };
  limits: { concurrency: number };
  defaults: {
    timeouts: { total_s: number | null; idle_s: number | null; waiting_s?: number | null };
    reclaim_after_s: number;
  };
  integrate_requires_ruling?: boolean;
}

export interface ModelCapability {
  id: string;
  tier: Tier;
  tier_source: 'runner_default' | 'instance_config';
  preferred_for_tier: boolean;
  aliases: string[];
  efforts: Effort[];
  default_effort: Effort;
  availability: 'verified' | 'assumed' | 'unavailable';
  verified_at: string | null;
}

export interface RunnerFeatures {
  read_only: { enforceable: boolean };
  usage: { streaming: boolean; final_receipt: 'exact' | 'partial' | 'none'; fields: string[] };
  cancel: { control_message: boolean; grace_s: number };
  interaction: { modes: ('autonomous' | 'interactive')[]; input: 'none' | 'stdin' | 'resume'; holds_slot_while_waiting: boolean; mid_turn_input: boolean };
  model_reporting: 'per_event' | 'final' | 'none';
  effort_reporting: 'per_event' | 'final' | 'none';
  limits: { max_steps: boolean };
  forbidden_enforcement: { action: string; level: 'enforced' | 'advisory' | 'audit' }[];
}

export interface AccountCapability {
  id: string;
  status: 'available' | 'cooldown' | 'held' | 'auth_down' | 'disabled';
  quota: { state: string; until: string | null; last_limit_hit_at: string | null };
  concurrency: { limit: number; running: number };
  features_delta: Partial<RunnerFeatures>;
  admission: { status: 'admitted' | 'suspended'; features_sha256: string };
  models: ModelCapability[];
}

export interface RunnerCapability {
  id: string;
  name: string;
  protocol_version: string;
  impl_version: string;
  native_version: string | null;
  admission: {
    status: 'admitted' | 'suspended';
    suite: string;
    suite_version: string;
    protocol_version: string;
    report_sha256: string;
    artifact_sha256: string;
    profiles: string[];
    revalidate_required: boolean;
    revalidate_deadline: string | null;
    safety_capabilities: 'active' | 'suspended';
    suspended_at: string | null;
    admitted_at: string | null;
  };
  health: {
    status: 'healthy' | 'degraded' | 'down' | 'unknown';
    components: { id: string; status: string; checked_at: string; detail: string | null }[];
  };
  features: RunnerFeatures;
  accounts: AccountCapability[];
}

export interface UnadmittedEntry {
  runner: string;
  account: string | null;
  reason: string;
}

export interface ServerConfig {
  instanceId?: string;
  implVersion?: string;
  runtime: Runtime;
  tokens: TokenConfig[];
  projects: ProjectConfig[];
  runners: RunnerCapability[];
  unadmitted?: UnadmittedEntry[];
  runBranchPrefix?: string;
  idempotencyWindowMs?: number;
  host?: string;
  port?: number;
  keepaliveMs?: number;
  ssePollMs?: number;
}

export interface DegradeSpec {
  capability: 'read_only' | 'max_steps';
  mode: 'advisory' | 'duration_cap';
  reason: string;
}

export interface Violation {
  rule: string;
  kind: 'schema' | 'dependency' | 'capability' | 'policy' | 'review';
  path: string;
  message: string;
  runner_rule?: string;
}

export interface WarningItem {
  rule: string;
  path: string;
  message: string;
}

export interface ThreeStageValue {
  requested: string;
  resolved: string | null;
  tier?: Tier | null;
  effective: string | null;
  effective_source: 'runner_reported' | 'unknown';
  auxiliary?: string[];
  mismatch: boolean;
}

export interface EffortThreeStageValue {
  requested: string;
  resolved_native: string | null;
  effective: string | null;
  effective_source: 'runner_reported' | 'unknown';
  mismatch: boolean;
}

export interface ReleaseState {
  state: 'pending' | 'completed' | 'aborted';
  requested_at: string;
  released_at: string | null;
  error: { reason: string; message?: string } | null;
}

export interface TaskRecord {
  id: string;
  object: 'task';
  project_id: string;
  title: string;
  goal: string;
  constraints: string[];
  level: Level;
  budget: Record<string, unknown> | null;
  state: 'open' | 'closed' | 'cancelled';
  outcome: Record<string, unknown> | null;
  run_ids: string[];
  client_ref: string | null;
  created_at: string;
  created_by: string;
  closed_at: string | null;
  version: number;
}

export interface RunMetadata {
  id: string;
  task_id: string;
  project_id: string;
  ref: string | null;
  role: Role;
  title: string;
  instructions: string;
  placement: {
    runner: string;
    account: string | null;
    account_requested: string | null;
    degrade: DegradeSpec[];
    fallbacks: unknown[];
    active_fallback_index: number | null;
  };
  model_record: ThreeStageValue;
  effort_record: EffortThreeStageValue;
  tier_rationale: string;
  priority: number;
  critical: boolean;
  depends_on: string[];
  interaction: 'autonomous' | 'interactive';
  on_interrupt: 'notify' | 'auto_continue';
  base: { kind: string; ref?: string; sha: string | null; resolved_at: string | null };
  workspace_mode: 'worktree' | 'in_place';
  branch: string;
  policy: {
    read_only: boolean;
    read_only_hard: boolean;
    toolchain_write: boolean;
    forbidden: string[];
    forbidden_guarantee: Record<string, string[]>;
  };
  degraded: DegradeSpec[];
  waivers: unknown[];
  continues: { run_id: string; mode: string; sha: string | null } | null;
  continued_by: string[];
  lineage: { branch_id: string; forked_from: string | null; candidate: { run_id: string; sha: string } | null; version: number } | null;
  created_at: string;
  created_by: string;
  started_at: string | null;
  ended_at: string | null;
  client_ref: string | null;
}

export interface RulingRecord {
  id: string;
  object: 'ruling';
  task_id: string;
  subject: { run_id: string; sha: string };
  branch: { id: string; version: number };
  decision: 'accept' | 'accept_with_notes' | 'rework' | 'reject';
  based_on: string[];
  note: string | null;
  by: string;
  at: string;
  status: 'effective' | 'superseded';
  version: number;
}

export interface JournalRecord {
  id: string;
  task_id: string;
  kind: 'intervention' | 'decision' | 'anomaly' | 'note';
  data: Record<string, unknown>;
  by: string;
  at: string;
}
