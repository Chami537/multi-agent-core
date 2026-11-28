import { effectiveFeatures } from './capabilities.js';
import {
  L4_ACTIONS,
  type AccountCapability,
  type DegradeSpec,
  type Effort,
  type Level,
  type ModelCapability,
  type ProjectConfig,
  type RunnerCapability,
  type Tier,
  type Violation,
  type WarningItem,
} from './types.js';

export function findUnknownFields(obj: unknown, allowed: readonly string[], prefix = ''): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const unknown: string[] = [];
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      unknown.push(prefix ? `${prefix}.${key}` : key);
    }
  }
  return unknown;
}

export const TASK_CREATE_FIELDS = [
  'project_id', 'title', 'goal', 'constraints', 'level', 'budget', 'runs', 'client_ref',
] as const;

export const RUN_SPEC_FIELDS = [
  'ref', 'role', 'title', 'instructions', 'runner', 'account', 'model', 'reasoning_effort',
  'tier_rationale', 'fallbacks', 'priority', 'critical', 'depends_on', 'base', 'workspace',
  'read_only', 'toolchain_write', 'review_of', 'target_branch', 'integrate_sources',
  'interaction', 'budget', 'timeouts', 'on_interrupt', 'degrade', 'waivers', 'context', 'client_ref',
] as const;

export const DEGRADE_FIELDS = ['capability', 'mode', 'reason'] as const;
export const BASE_FIELDS = ['kind', 'ref', 'sha', 'run_id'] as const;
export const TIMEOUTS_FIELDS = ['total_s', 'idle_s', 'waiting_s'] as const;
export const CONTEXT_FIELDS = ['notes'] as const;
export const PATCH_RUN_FIELDS = [
  'title', 'priority', 'critical', 'depends_on', 'runner', 'account', 'fallbacks',
  'model', 'reasoning_effort', 'tier_rationale', 'budget', 'timeouts', 'degrade', 'waivers',
] as const;
export const CONTINUE_FIELDS = [
  'mode', 'verdicts', 'ruling_id', 'notes', 'overrides', 'rehome_dependents', 'source_version',
] as const;
export const OVERRIDES_FIELDS = [
  'runner', 'account', 'model', 'reasoning_effort', 'tier_rationale', 'interaction',
  'instructions_append', 'degrade', 'timeouts', 'budget', 'fallbacks', 'depends_on',
  'waivers', 'priority', 'critical',
] as const;

export function collectTaskCreateUnknownFields(body: Record<string, unknown>): string[] {
  const unknown = findUnknownFields(body, TASK_CREATE_FIELDS);
  if (Array.isArray(body.runs)) {
    body.runs.forEach((run, i) => {
      if (run && typeof run === 'object' && !Array.isArray(run)) {
        unknown.push(...collectRunSpecUnknownFields(run as Record<string, unknown>, `runs[${i}]`));
      }
    });
  }
  return unknown;
}

export function collectRunSpecUnknownFields(spec: Record<string, unknown>, prefix: string): string[] {
  const unknown = findUnknownFields(spec, RUN_SPEC_FIELDS, prefix);
  if (Array.isArray(spec.degrade)) {
    spec.degrade.forEach((d, idx) => {
      unknown.push(...findUnknownFields(d, DEGRADE_FIELDS, `${prefix}.degrade[${idx}]`));
    });
  }
  if (spec.base && typeof spec.base === 'object' && !Array.isArray(spec.base)) {
    unknown.push(...findUnknownFields(spec.base, BASE_FIELDS, `${prefix}.base`));
  }
  if (spec.timeouts && typeof spec.timeouts === 'object' && !Array.isArray(spec.timeouts)) {
    unknown.push(...findUnknownFields(spec.timeouts, TIMEOUTS_FIELDS, `${prefix}.timeouts`));
  }
  if (spec.context && typeof spec.context === 'object' && !Array.isArray(spec.context)) {
    unknown.push(...findUnknownFields(spec.context, CONTEXT_FIELDS, `${prefix}.context`));
  }
  return unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function validateRunSpecTypes(spec: Record<string, unknown>, prefix: string, isPatch = false): Violation[] {
  const v: Violation[] = [];
  const p = (f: string) => (prefix ? `${prefix}.${f}` : f);

  if (spec.client_ref !== undefined && spec.client_ref !== null) {
    if (typeof spec.client_ref !== 'string' || spec.client_ref.length < 1 || spec.client_ref.length > 128) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('client_ref'), message: 'client_ref must be 1..128 chars' });
    }
  }
  if (spec.ref !== undefined && spec.ref !== null) {
    if (typeof spec.ref !== 'string' || spec.ref.length < 1 || spec.ref.length > 128) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('ref'), message: 'ref must be 1..128 chars' });
    }
  }
  if (spec.critical !== undefined && typeof spec.critical !== 'boolean') {
    v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('critical'), message: 'critical must be a boolean' });
  }
  if (spec.priority !== undefined) {
    if (typeof spec.priority !== 'number' || !Number.isSafeInteger(spec.priority) || spec.priority < 0 || spec.priority > 100) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('priority'), message: 'priority must be an integer 0..100' });
    }
  }
  if (spec.read_only !== undefined && typeof spec.read_only !== 'boolean') {
    v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('read_only'), message: 'read_only must be a boolean' });
  }
  if (spec.toolchain_write !== undefined && typeof spec.toolchain_write !== 'boolean') {
    v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('toolchain_write'), message: 'toolchain_write must be a boolean' });
  }
  if (spec.depends_on !== undefined) {
    if (!Array.isArray(spec.depends_on) || spec.depends_on.some(d => typeof d !== 'string' || d.length < 1)) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('depends_on'), message: 'depends_on must be an array of non-empty strings' });
    }
  }
  if (spec.fallbacks !== undefined) {
    if (!Array.isArray(spec.fallbacks) || spec.fallbacks.some(f => !isPlainObject(f))) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('fallbacks'), message: 'fallbacks must be an array of objects' });
    }
  }
  if (spec.waivers !== undefined) {
    if (!Array.isArray(spec.waivers) || spec.waivers.some(w => typeof w !== 'string' && !isPlainObject(w))) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('waivers'), message: 'waivers must be an array of strings or objects' });
    }
  }
  if (spec.on_interrupt !== undefined && !['notify', 'auto_continue'].includes(String(spec.on_interrupt))) {
    v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('on_interrupt'), message: 'on_interrupt must be notify or auto_continue' });
  }
  if (spec.timeouts !== undefined) {
    if (!isPlainObject(spec.timeouts)) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('timeouts'), message: 'timeouts must be an object' });
    } else {
      for (const k of TIMEOUTS_FIELDS) {
        const val = spec.timeouts[k];
        if (val !== undefined && val !== null && (typeof val !== 'number' || !Number.isFinite(val) || val < 0)) {
          v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p(`timeouts.${k}`), message: `timeouts.${k} must be null or a non-negative number` });
        }
      }
    }
  }
  if (spec.base !== undefined) {
    if (!isPlainObject(spec.base)) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('base'), message: 'base must be an object' });
    } else if (typeof spec.base.kind !== 'string' || !['branch', 'commit', 'wip', 'run'].includes(spec.base.kind)) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('base.kind'), message: 'base.kind must be branch, commit, wip, or run' });
    }
  }
  if (spec.context !== undefined) {
    if (!isPlainObject(spec.context)) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('context'), message: 'context must be an object' });
    } else if (spec.context.notes !== undefined && typeof spec.context.notes !== 'string') {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('context.notes'), message: 'context.notes must be a string' });
    }
  }
  if (spec.degrade !== undefined) {
    if (!Array.isArray(spec.degrade)) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('degrade'), message: 'degrade must be an array' });
    } else {
      spec.degrade.forEach((d, idx) => {
        if (!isPlainObject(d)) {
          v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p(`degrade[${idx}]`), message: 'degrade entry must be an object' });
        }
      });
    }
  }
  if (isPatch) {
    if (spec.title !== undefined && (typeof spec.title !== 'string' || spec.title.length < 1 || spec.title.length > 120)) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('title'), message: 'title must be 1..120 chars' });
    }
    if (spec.runner !== undefined && (typeof spec.runner !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(spec.runner))) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('runner'), message: 'Invalid runner slug' });
    }
    if (spec.account !== undefined && spec.account !== null && (typeof spec.account !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(spec.account))) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('account'), message: 'Invalid account slug' });
    }
    if (spec.model !== undefined && (typeof spec.model !== 'string' || spec.model.length < 1)) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('model'), message: 'model must be a non-empty string' });
    }
    if (spec.reasoning_effort !== undefined && (typeof spec.reasoning_effort !== 'string' || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default'].includes(spec.reasoning_effort))) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('reasoning_effort'), message: 'Invalid reasoning_effort' });
    }
    if (spec.tier_rationale !== undefined && (typeof spec.tier_rationale !== 'string' || spec.tier_rationale.length < 1 || spec.tier_rationale.length > 200)) {
      v.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: p('tier_rationale'), message: 'tier_rationale must be 1..200 chars' });
    }
  }
  return v;
}

export interface OutOfPhaseResult {
  paths: string[];
  availableIn: string;
}

export function checkTaskCreatePhase1(body: Record<string, unknown>): OutOfPhaseResult | null {
  const paths: string[] = [];
  let availableIn = 'Phase 2';
  if (body.budget !== undefined && body.budget !== null) {
    paths.push('budget');
    availableIn = 'Phase 3';
  }
  if (Array.isArray(body.runs)) {
    body.runs.forEach((r, i) => {
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        const res = checkRunSpecPhase1(r as Record<string, unknown>, `runs[${i}]`);
        if (res) {
          paths.push(...res.paths);
          availableIn = res.availableIn;
        }
      }
    });
  }
  return paths.length > 0 ? { paths, availableIn } : null;
}

export function checkRunSpecPhase1(spec: Record<string, unknown>, prefix: string): OutOfPhaseResult | null {
  const paths: string[] = [];
  let availableIn = 'Phase 2';

  if (Array.isArray(spec.depends_on) && spec.depends_on.length > 0) paths.push(`${prefix}.depends_on`);
  if (spec.priority !== undefined && spec.priority !== 50) paths.push(`${prefix}.priority`);
  if (spec.base && typeof spec.base === 'object' && (spec.base as Record<string, unknown>).kind === 'run') {
    paths.push(`${prefix}.base.kind`);
  }
  if (Array.isArray(spec.fallbacks) && spec.fallbacks.length > 0) paths.push(`${prefix}.fallbacks`);
  if (spec.on_interrupt !== undefined && spec.on_interrupt !== 'notify') paths.push(`${prefix}.on_interrupt`);

  if (spec.budget !== undefined && spec.budget !== null) {
    paths.push(`${prefix}.budget`);
    availableIn = 'Phase 3';
  }
  if (Array.isArray(spec.degrade)) {
    spec.degrade.forEach((d, j) => {
      if (d && typeof d === 'object' && (d as Record<string, unknown>).capability === 'max_steps') {
        paths.push(`${prefix}.degrade[${j}]`);
        availableIn = 'Phase 3';
      }
    });
  }

  if (typeof spec.role === 'string' && ['review', 'audit', 'integrate'].includes(spec.role)) {
    paths.push(`${prefix}.role`);
    availableIn = 'Phase 4';
  }
  if (spec.review_of !== undefined && spec.review_of !== null) {
    paths.push(`${prefix}.review_of`);
    availableIn = 'Phase 4';
  }
  if (spec.target_branch !== undefined && spec.target_branch !== null) {
    paths.push(`${prefix}.target_branch`);
    availableIn = 'Phase 4';
  }
  if (spec.integrate_sources !== undefined && spec.integrate_sources !== null) {
    paths.push(`${prefix}.integrate_sources`);
    availableIn = 'Phase 4';
  }
  if (Array.isArray(spec.waivers) && spec.waivers.length > 0) {
    paths.push(`${prefix}.waivers`);
    availableIn = 'Phase 4';
  }

  return paths.length > 0 ? { paths, availableIn } : null;
}

const LEVEL_RANK: Record<Level, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

export interface ResolvedRunTarget {
  runner: RunnerCapability;
  account: AccountCapability | null;
  candidates: {
    runner: string;
    account: string;
    model: string;
    aliases: string[];
    tier: Tier;
    reasoning_effort: string;
    resolved_native: string | null;
    account_status: string;
    degraded: DegradeSpec[];
    forbidden_guarantee: Record<string, string[]>;
  }[];
  read_only: boolean;
  read_only_hard: boolean;
  toolchain_write: boolean;
  workspace: 'worktree' | 'in_place';
  interaction: 'autonomous' | 'interactive';
}

export function validateRunSpec(params: {
  spec: Record<string, unknown>;
  pathPrefix: string;
  taskLevel: Level;
  project: ProjectConfig;
  runners: RunnerCapability[];
}): {
  violations: Violation[];
  warnings: WarningItem[];
  resolved: ResolvedRunTarget | null;
} {
  const { spec, pathPrefix, taskLevel, project, runners } = params;
  const violations: Violation[] = [...validateRunSpecTypes(spec, pathPrefix, false)];
  const warnings: WarningItem[] = [];

  const role = spec.role;
  const title = spec.title;
  const instructions = spec.instructions;
  const runnerId = spec.runner;
  const accountId = spec.account ?? null;
  const modelReq = spec.model;
  const effortReq = spec.reasoning_effort;
  const tierRationale = spec.tier_rationale;

  if (typeof role !== 'string' || !['dev', 'design', 'review', 'audit', 'integrate'].includes(role)) {
    violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.role`, message: 'Invalid role' });
  }
  if (typeof title !== 'string' || title.length < 1 || title.length > 120) {
    violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.title`, message: 'title must be 1..120 chars' });
  }
  if (typeof instructions !== 'string' || Buffer.byteLength(instructions) > 200 * 1024) {
    violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.instructions`, message: 'instructions must be string <= 200 KiB' });
  }
  if (typeof runnerId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(runnerId)) {
    violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.runner`, message: 'Invalid runner slug' });
  }
  if (accountId !== null && (typeof accountId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(accountId))) {
    violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.account`, message: 'Invalid account slug' });
  }
  if (typeof modelReq !== 'string' || modelReq.length < 1) {
    violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.model`, message: 'model is required' });
  }
  if (typeof effortReq !== 'string' || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default'].includes(effortReq)) {
    violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.reasoning_effort`, message: 'Invalid reasoning_effort' });
  }
  if (typeof tierRationale !== 'string' || tierRationale.length < 1 || tierRationale.length > 200) {
    violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.tier_rationale`, message: 'tier_rationale must be 1..200 chars' });
  }

  const workspace = (spec.workspace ?? 'worktree') as 'worktree' | 'in_place';
  if (!['worktree', 'in_place'].includes(workspace)) {
    violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.workspace`, message: 'workspace must be worktree or in_place' });
  }

  const readOnly = spec.read_only !== undefined ? Boolean(spec.read_only) : (role === 'review' || role === 'audit');
  const readOnlyHard = taskLevel === 'L1';
  const toolchainWrite = Boolean(spec.toolchain_write ?? false);
  const interaction = (spec.interaction ?? 'autonomous') as 'autonomous' | 'interactive';
  if (!['autonomous', 'interactive'].includes(interaction)) {
    violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.interaction`, message: 'Invalid interaction mode' });
  }

  const degradeList: DegradeSpec[] = [];
  if (spec.degrade !== undefined) {
    if (!Array.isArray(spec.degrade)) {
      violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.degrade`, message: 'degrade must be an array' });
    } else {
      spec.degrade.forEach((d, idx) => {
        if (!d || typeof d !== 'object') {
          violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: `${pathPrefix}.degrade[${idx}]`, message: 'Invalid degrade entry' });
          return;
        }
        const item = d as Record<string, unknown>;
        if (!['read_only', 'max_steps'].includes(String(item.capability)) || typeof item.reason !== 'string' || item.reason.length < 1 || item.reason.length > 200) {
          violations.push({ rule: 'DEGRADE_INVALID', kind: 'capability', path: `${pathPrefix}.degrade[${idx}]`, message: 'Invalid degrade capability or reason' });
          return;
        }
        if (item.capability === 'read_only' && item.mode !== 'advisory') {
          violations.push({ rule: 'DEGRADE_INVALID', kind: 'capability', path: `${pathPrefix}.degrade[${idx}].mode`, message: 'read_only can only degrade to advisory' });
          return;
        }
        degradeList.push({
          capability: item.capability as 'read_only' | 'max_steps',
          mode: item.mode as 'advisory' | 'duration_cap',
          reason: item.reason,
        });
      });
    }
  }

  // Policy level checks (§7.3)
  if (taskLevel === 'L1' && !readOnly) {
    violations.push({ rule: 'LEVEL_INSUFFICIENT', kind: 'policy', path: `${pathPrefix}.read_only`, message: 'L1 requires read_only: true' });
  }
  if (taskLevel === 'L1' && degradeList.some(d => d.capability === 'read_only')) {
    violations.push({ rule: 'DEGRADE_FORBIDDEN_BY_POLICY', kind: 'policy', path: `${pathPrefix}.degrade`, message: 'L1 hard read_only cannot be degraded to advisory' });
  }
  if (taskLevel === 'L2' && (workspace === 'in_place' || toolchainWrite)) {
    violations.push({ rule: 'LEVEL_INSUFFICIENT', kind: 'policy', path: `${pathPrefix}`, message: 'L2 forbids in_place workspace and toolchain_write' });
  }

  if (typeof runnerId !== 'string') {
    return { violations, warnings, resolved: null };
  }

  const runner = runners.find(r => r.id === runnerId && r.admission.status === 'admitted' && r.accounts.some(a => a.admission.status === 'admitted'));
  if (!runner) {
    violations.push({ rule: 'RUNNER_UNKNOWN', kind: 'capability', path: `${pathPrefix}.runner`, message: `Runner '${runnerId}' not found or not admitted` });
    return { violations, warnings, resolved: null };
  }

  let candidateAccounts: AccountCapability[] = runner.accounts.filter(a => a.admission.status === 'admitted');
  if (accountId !== null) {
    const exact = candidateAccounts.find(a => a.id === accountId);
    if (!exact) {
      violations.push({ rule: 'ACCOUNT_UNKNOWN', kind: 'capability', path: `${pathPrefix}.account`, message: `Account '${String(accountId)}' not found on runner '${runnerId}'` });
      return { violations, warnings, resolved: null };
    }
    candidateAccounts = [exact];
  }

  // Evaluate each candidate account
  const validCandidates: ResolvedRunTarget['candidates'] = [];
  const accountErrors: Violation[] = [];
  let anyNeededReadOnlyDegrade = false;

  const hasReadOnlyDegrade = degradeList.some(d => d.capability === 'read_only' && d.mode === 'advisory');

  for (const acc of candidateAccounts) {
    const feats = effectiveFeatures(runner, acc);
    const localErrors: Violation[] = [];

    // Resolve model
    let modelEntry: ModelCapability | undefined;
    if (typeof modelReq === 'string') {
      if (modelReq.startsWith('@')) {
        const tier = modelReq.slice(1) as Tier;
        if (!['low', 'mid', 'high'].includes(tier)) {
          localErrors.push({ rule: 'TIER_UNRESOLVABLE', kind: 'capability', path: `${pathPrefix}.model`, message: `Unknown tier alias '${modelReq}'` });
        } else {
          modelEntry = acc.models.find(m => m.tier === tier && m.preferred_for_tier && m.availability !== 'unavailable');
          if (!modelEntry) {
            localErrors.push({ rule: 'TIER_UNRESOLVABLE', kind: 'capability', path: `${pathPrefix}.model`, message: `No preferred model for tier '${tier}' on account '${acc.id}'` });
          }
        }
      } else {
        modelEntry = acc.models.find(m => m.id === modelReq && m.availability !== 'unavailable');
        if (!modelEntry) {
          localErrors.push({ rule: 'MODEL_UNAVAILABLE', kind: 'capability', path: `${pathPrefix}.model`, message: `Model '${modelReq}' unavailable on account '${acc.id}'` });
        }
      }
    }

    // Effort check (no silent fallback!)
    if (modelEntry && typeof effortReq === 'string') {
      if (!modelEntry.efforts.includes(effortReq as Effort)) {
        localErrors.push({
          rule: 'EFFORT_UNSUPPORTED',
          kind: 'capability',
          path: `${pathPrefix}.reasoning_effort`,
          message: `Effort '${effortReq}' is not supported by model '${modelEntry.id}' (supported: ${modelEntry.efforts.join(', ')})`,
        });
      }
    }

    // Read-only check
    const appliedDegrades: DegradeSpec[] = [];
    if (readOnly && !feats.read_only.enforceable) {
      if (hasReadOnlyDegrade) {
        anyNeededReadOnlyDegrade = true;
        const d = degradeList.find(x => x.capability === 'read_only')!;
        appliedDegrades.push(d);
      } else {
        localErrors.push({
          rule: 'CAP_READ_ONLY_UNENFORCEABLE',
          kind: 'capability',
          path: `${pathPrefix}.read_only`,
          message: `Runner '${runner.id}' account '${acc.id}' cannot enforce read_only; authorize degrade: read_only/advisory if acceptable`,
        });
      }
    }

    // Interaction check
    if (interaction === 'interactive' && !feats.interaction.modes.includes('interactive')) {
      localErrors.push({
        rule: 'CAP_INTERACTION_UNSUPPORTED',
        kind: 'capability',
        path: `${pathPrefix}.interaction`,
        message: `Runner '${runner.id}' account '${acc.id}' does not support interactive mode`,
      });
    }

    // Forbidden runtime enforcement check
    const forbiddenGuarantee: Record<string, string[]> = {};
    const allForbidden = new Map<string, 'dispatch' | 'runtime'>();
    for (const act of L4_ACTIONS) allForbidden.set(act, 'dispatch');
    for (const f of project.forbidden) {
      const prev = allForbidden.get(f.action);
      allForbidden.set(f.action, f.enforcement === 'runtime' || prev === 'runtime' ? 'runtime' : 'dispatch');
    }
    for (const [action, enforcement] of allForbidden.entries()) {
      const runnerLevels = feats.forbidden_enforcement.filter(e => e.action === action).map(e => e.level);
      const levels = new Set<string>(['advisory', ...runnerLevels]);
      forbiddenGuarantee[action] = [...levels];
      if (enforcement === 'runtime' && !levels.has('enforced')) {
        localErrors.push({
          rule: 'FORBIDDEN_UNENFORCEABLE',
          kind: 'policy',
          path: `${pathPrefix}`,
          message: `Project requires runtime enforcement for '${action}' but target has no enforced mechanism`,
        });
      }
    }

    if (localErrors.length === 0 && modelEntry) {
      validCandidates.push({
        runner: runner.id,
        account: acc.id,
        model: modelEntry.id,
        aliases: [...modelEntry.aliases],
        tier: modelEntry.tier,
        reasoning_effort: String(effortReq),
        resolved_native: effortReq === 'default' ? null : String(effortReq),
        account_status: acc.status,
        degraded: appliedDegrades,
        forbidden_guarantee: forbiddenGuarantee,
      });
      if (modelEntry.availability === 'assumed') {
        warnings.push({ rule: 'MODEL_AVAILABILITY_ASSUMED', path: `${pathPrefix}.model`, message: `Model '${modelEntry.id}' availability is assumed` });
      }
      if (runner.health.status !== 'healthy' || acc.status !== 'available') {
        warnings.push({ rule: 'RUNNER_DEGRADED', path: `${pathPrefix}.runner`, message: `Target '${runner.id}/${acc.id}' is not currently healthy/available` });
      }
    } else {
      accountErrors.push(...localErrors);
    }
  }

  if (hasReadOnlyDegrade && (!readOnly || !anyNeededReadOnlyDegrade) && validCandidates.length > 0) {
    violations.push({
      rule: 'DEGRADE_INVALID',
      kind: 'capability',
      path: `${pathPrefix}.degrade`,
      message: 'read_only degrade authorized but all candidate accounts already enforce read_only (or read_only is false)',
    });
  }

  if (validCandidates.length === 0) {
    // Deduplicate by rule+path
    const seen = new Set<string>();
    for (const e of accountErrors) {
      const k = `${e.rule}:${e.path}`;
      if (!seen.has(k)) {
        seen.add(k);
        violations.push(e);
      }
    }
  }

  if (violations.length > 0) {
    return { violations, warnings, resolved: null };
  }

  return {
    violations: [],
    warnings,
    resolved: {
      runner,
      account: accountId !== null ? candidateAccounts[0]! : null,
      candidates: validCandidates,
      read_only: readOnly,
      read_only_hard: readOnlyHard,
      toolchain_write: toolchainWrite,
      workspace,
      interaction,
    },
  };
}

export function validateTaskLevel(level: unknown, project: ProjectConfig): Violation[] {
  const violations: Violation[] = [];
  if (typeof level !== 'string' || !['L1', 'L2', 'L3', 'L4'].includes(level)) {
    violations.push({ rule: 'SCHEMA_INVALID', kind: 'schema', path: 'level', message: 'level must be L1, L2, L3, or L4' });
    return violations;
  }
  if (level === 'L4') {
    violations.push({ rule: 'LEVEL_L4_FORBIDDEN', kind: 'policy', path: 'level', message: 'L4 is forbidden in Supervisor Protocol 0.2' });
    return violations;
  }
  const effectiveMax: Level = project.max_level === 'L4' ? 'L3' : project.max_level;
  if (LEVEL_RANK[level as Level] > LEVEL_RANK[effectiveMax]) {
    violations.push({
      rule: 'LEVEL_EXCEEDS_PROJECT',
      kind: 'policy',
      path: 'level',
      message: `Task level '${level}' exceeds project max_level '${effectiveMax}'`,
    });
  }
  return violations;
}
