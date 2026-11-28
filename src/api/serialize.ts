import { isTerminal } from '../core/state-machine.js';
import type { Run, State } from '../core/types.js';
import type { EffortThreeStageValue, ReleaseState, RunMetadata, TaskRecord, ThreeStageValue } from './types.js';

export function buildModelAndEffortRecords(
  run: Run,
  meta: RunMetadata,
): { model_record: ThreeStageValue; effort_record: EffortThreeStageValue } {
  const repModel = run.reportedModel ?? (run.candidate?.data.model as Run['reportedModel'] | undefined);
  const effectiveModel = typeof repModel?.effective === 'string' ? repModel.effective : null;
  const modelSource: 'runner_reported' | 'unknown' =
    effectiveModel !== null && (repModel?.effective_source === 'native_reported' || repModel?.effective_source === 'runner_reported')
      ? 'runner_reported'
      : 'unknown';
  const auxiliary = Array.isArray(repModel?.auxiliary)
    ? repModel.auxiliary.map(String)
    : (meta.model_record.auxiliary ?? []);
  const modelMismatch =
    effectiveModel !== null && meta.model_record.resolved !== null
      ? effectiveModel !== meta.model_record.resolved && !(run.modelAliases ?? []).includes(effectiveModel)
      : meta.model_record.mismatch;

  const model_record: ThreeStageValue = {
    ...meta.model_record,
    effective: effectiveModel ?? meta.model_record.effective,
    effective_source: effectiveModel !== null ? modelSource : meta.model_record.effective_source,
    auxiliary,
    mismatch: modelMismatch,
  };

  const repEffort = run.reportedEffort ?? (run.candidate?.data.reasoning_effort as Run['reportedEffort'] | undefined);
  const effectiveEffort = typeof repEffort?.effective === 'string' ? repEffort.effective : null;
  const effortSource: 'runner_reported' | 'unknown' =
    effectiveEffort !== null && (repEffort?.effective_source === 'native_reported' || repEffort?.effective_source === 'runner_reported')
      ? 'runner_reported'
      : 'unknown';
  const resolvedNative =
    typeof repEffort?.requested_native === 'string'
      ? repEffort.requested_native
      : meta.effort_record.resolved_native;
  const effortMismatch =
    effectiveEffort !== null && meta.effort_record.requested !== 'default'
      ? effectiveEffort !== meta.effort_record.requested
      : meta.effort_record.mismatch;

  const effort_record: EffortThreeStageValue = {
    ...meta.effort_record,
    resolved_native: resolvedNative,
    effective: effectiveEffort ?? meta.effort_record.effective,
    effective_source: effectiveEffort !== null ? effortSource : meta.effort_record.effective_source,
    mismatch: effortMismatch,
  };

  return { model_record, effort_record };
}

export function serializeTask(task: TaskRecord, runs: Run[]): Record<string, unknown> {
  const runCounts: Record<string, number> = {};
  for (const r of runs) {
    runCounts[r.state] = (runCounts[r.state] ?? 0) + 1;
  }
  return {
    ...task,
    run_counts: runCounts,
    usage: {
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      extra: {},
      completeness: 'unknown',
      source: 'none',
      cache_in_input: null,
      budget_tokens: null,
      budget_basis: 'unknown',
      estimated_cost: null,
    },
    budget_status: {
      tokens_used: 0,
      estimated_cost_usd: 0,
      ratio: 0,
      state: 'ok',
      unknown_runs: runs.filter(r => r.usage.input_tokens === null).length,
    },
  };
}

export function serializeUsage(run: Run): Record<string, unknown> {
  const u = run.usage;
  const cacheInInput = u.basis.cache_in_input;
  let budgetTokens: number | null = null;
  let budgetBasis: 'exact' | 'conservative' | 'unknown' = 'unknown';
  if (u.input_tokens !== null && u.output_tokens !== null) {
    if (cacheInInput === false) {
      budgetTokens = u.input_tokens + u.output_tokens;
      budgetBasis = 'exact';
    } else if (cacheInInput === true && u.cache_read_tokens !== null) {
      budgetTokens = u.input_tokens - u.cache_read_tokens + u.output_tokens;
      budgetBasis = 'exact';
    } else {
      budgetTokens = u.input_tokens + u.output_tokens;
      budgetBasis = 'conservative';
    }
  }
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_tokens: u.cache_read_tokens,
    cache_write_tokens: u.cache_write_tokens,
    extra: u.extra,
    completeness: u.completeness,
    source: u.completeness === 'exact' ? 'runner_final' : u.completeness === 'partial' ? 'runner_stream' : 'none',
    cache_in_input: cacheInInput,
    budget_tokens: budgetTokens,
    budget_basis: budgetBasis,
    estimated_cost: u.native_cost_usd !== null ? { usd: u.native_cost_usd, basis: 'runner_native', estimate: true } : null,
  };
}

export function serializeRunResult(run: Run, meta: RunMetadata): Record<string, unknown> | null {
  if (!isTerminal(run.state) && run.state !== 'paused' && run.state !== 'waiting') return null;
  const { model_record, effort_record } = buildModelAndEffortRecords(run, meta);
  return {
    code: run.reason ?? (run.state === 'done' ? 'completed' : run.state),
    branch: meta.branch,
    base_sha: meta.base.sha,
    head_sha: run.workspaceHead,
    wip_sha: run.preservation.kind === 'wip' ? run.preservation.sha : null,
    preservation: {
      state: run.preservation.state === 'saved' ? 'ok' : run.preservation.state,
      kind: run.preservation.kind ?? 'none',
      error: run.preservation.error,
      ignored_files: { count: 0, sample: [] },
    },
    commits: 0,
    diffstat: { files: 0, insertions: 0, deletions: 0 },
    final_message: run.candidate?.data.final_message ?? null,
    artifacts: [],
    verdict: null,
    policy_breaches: [],
    degraded: meta.degraded,
    usage: serializeUsage(run),
    model: model_record,
    reasoning_effort: effort_record,
    turns: run.candidate?.data.turns ?? null,
    steps: run.usage.steps,
    duration_s: Math.floor(run.clocks.totalMs / 1000),
  };
}

export function serializeRun(run: Run, meta: RunMetadata, release: ReleaseState | null): Record<string, unknown> {
  const { model_record, effort_record } = buildModelAndEffortRecords(run, meta);

  return {
    id: run.id,
    object: 'run',
    task_id: run.taskId,
    project_id: run.projectId,
    ref: meta.ref,
    role: run.role,
    title: meta.title,
    instructions: meta.instructions,
    state: run.state,
    state_reason: run.reason
      ? {
          code: run.reason,
          category: 'framework',
          source: 'framework',
          message: run.reason,
          retryable: false,
          retry_after_s: null,
          detail: null,
        }
      : null,
    state_changed_at: meta.created_at,
    occupies_slot: run.reservation,
    waiting_on: null,
    placement: meta.placement,
    model: model_record,
    reasoning_effort: effort_record,
    tier_rationale: meta.tier_rationale,
    priority: meta.priority,
    critical: meta.critical,
    depends_on: meta.depends_on,
    interaction: meta.interaction,
    on_interrupt: meta.on_interrupt,
    timeouts: run.timeouts,
    budget: { tokens: null, estimated_cost_usd: null, max_steps: run.maxSteps },
    base: meta.base,
    workspace: {
      mode: meta.workspace_mode,
      branch: meta.branch,
      retention: {
        protected: run.protected || run.state === 'paused' || run.state === 'interrupted',
        reclaim_after: null,
        reclaimed_at: release?.state === 'completed' ? release.released_at : null,
        release,
      },
    },
    policy: meta.policy,
    degraded: meta.degraded,
    waivers: meta.waivers,
    review_of: null,
    continues: meta.continues,
    continued_by: meta.continued_by,
    lineage: meta.lineage,
    leases: [],
    stop_request: run.stop
      ? {
          kind: run.stop.kind,
          reason: run.stop.reason,
          requested_at: new Date(run.stop.requestedAt).toISOString(),
          by: meta.created_by,
          stop_sent_at: run.stop.sentAt !== null ? new Date(run.stop.sentAt).toISOString() : null,
          escalate_at: null,
        }
      : null,
    finalizing: run.finalizing,
    launch_attempts: run.launchAttempts,
    segments: run.segment,
    usage: serializeUsage(run),
    result: serializeRunResult(run, meta),
    created_at: meta.created_at,
    created_by: meta.created_by,
    started_at: meta.started_at,
    ended_at: meta.ended_at,
    client_ref: meta.client_ref,
    version: run.version,
  };
}

export function allowedOpsForState(state: State, midTurnInput = false): string[] {
  switch (state) {
    case 'queued':
    case 'blocked':
    case 'held':
      return ['cancel', 'pause', 'patch'];
    case 'leasing':
      return ['cancel', 'pause'];
    case 'running':
      return midTurnInput ? ['cancel', 'pause', 'messages'] : ['cancel', 'pause'];
    case 'waiting':
      return ['cancel', 'pause', 'messages', 'complete'];
    case 'paused':
      return ['cancel', 'continue'];
    case 'done':
      return ['continue', 'release-worktree'];
    case 'failed':
    case 'interrupted':
      return ['continue', 'release-worktree'];
    case 'cancelled':
      return ['release-worktree'];
  }
}
