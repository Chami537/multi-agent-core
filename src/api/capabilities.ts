import type { Store } from '../store/database.js';
import { canonicalJson, sha256Hex } from './protocol.js';
import {
  PROTOCOL_VERSION,
  VOCABULARY,
  type AccountCapability,
  type RunnerCapability,
  type RunnerFeatures,
  type UnadmittedEntry,
} from './types.js';

export function effectiveFeatures(runner: RunnerCapability, account: AccountCapability): RunnerFeatures {
  const merged: RunnerFeatures = {
    read_only: { ...runner.features.read_only, ...(account.features_delta.read_only ?? {}) },
    usage: { ...runner.features.usage, ...(account.features_delta.usage ?? {}) },
    cancel: { ...runner.features.cancel, ...(account.features_delta.cancel ?? {}) },
    interaction: { ...runner.features.interaction, ...(account.features_delta.interaction ?? {}) },
    model_reporting: account.features_delta.model_reporting ?? runner.features.model_reporting,
    effort_reporting: account.features_delta.effort_reporting ?? runner.features.effort_reporting,
    limits: { ...runner.features.limits, ...(account.features_delta.limits ?? {}) },
    forbidden_enforcement: account.features_delta.forbidden_enforcement ?? runner.features.forbidden_enforcement,
  };
  if (runner.admission.safety_capabilities === 'suspended' || runner.admission.revalidate_required) {
    merged.read_only = { enforceable: false };
    merged.forbidden_enforcement = [];
  }
  return merged;
}

export function buildCapabilitiesPayload(params: {
  instanceId: string;
  store: Store;
  runners: RunnerCapability[];
  unadmitted: UnadmittedEntry[];
  projectLimits: Record<string, number>;
  globalLimit: number;
  now?: number;
}): { payload: Record<string, unknown>; etag: string } {
  const runs = params.store.list();
  let running = 0;
  let queued = 0;
  let blocked = 0;
  let held = 0;
  let paused = 0;
  const projectRunning: Record<string, number> = {};
  const accountRunning: Record<string, number> = {};

  for (const r of runs) {
    if (r.reservation) {
      running++;
      projectRunning[r.projectId] = (projectRunning[r.projectId] ?? 0) + 1;
      accountRunning[r.account] = (accountRunning[r.account] ?? 0) + 1;
    }
    if (r.state === 'queued') queued++;
    else if (r.state === 'blocked') blocked++;
    else if (r.state === 'held') held++;
    else if (r.state === 'paused') paused++;
  }

  const runners = params.runners
    .filter(r => r.accounts.some(a => a.admission.status === 'admitted'))
    .map(r => ({
      ...r,
      accounts: r.accounts
        .filter(a => a.admission.status === 'admitted')
        .map(a => ({
          ...a,
          concurrency: { ...a.concurrency, running: accountRunning[a.id] ?? a.concurrency.running },
        })),
    }));

  const projects = Object.entries(params.projectLimits).map(([project_id, limit]) => ({
    project_id,
    limit,
    running: projectRunning[project_id] ?? 0,
  }));

  const stableForEtag = {
    protocol: PROTOCOL_VERSION,
    instance_id: params.instanceId,
    vocabulary: VOCABULARY,
    runners,
    unadmitted: params.unadmitted,
  };
  const etag = `"${sha256Hex(canonicalJson(stableForEtag)).slice(0, 16)}"`;

  const payload = {
    protocol: PROTOCOL_VERSION,
    instance_id: params.instanceId,
    as_of: new Date(params.now ?? Date.now()).toISOString(),
    vocabulary: VOCABULARY,
    scheduler: {
      global: { limit: params.globalLimit, running },
      projects,
      queued,
      blocked,
      held,
      paused,
    },
    runners,
    unadmitted: params.unadmitted,
  };

  return { payload, etag };
}

export function defaultFakeCapabilities(): RunnerCapability[] {
  return [
    {
      id: 'fake',
      name: 'Fake Runner',
      protocol_version: '0.2',
      impl_version: '0.1.0',
      native_version: '0.1.0',
      admission: {
        status: 'admitted',
        suite: 'mac.runner',
        suite_version: '0.2.0',
        protocol_version: '0.2',
        report_sha256: '0'.repeat(64),
        artifact_sha256: '0'.repeat(64),
        profiles: ['core', 'usage-stream', 'interactive-resume'],
        revalidate_required: false,
        revalidate_deadline: null,
        safety_capabilities: 'active',
        suspended_at: null,
        admitted_at: '2026-11-27T00:00:00.000Z',
      },
      health: {
        status: 'healthy',
        components: [{ id: 'auth', status: 'ok', checked_at: '2026-11-27T00:00:00.000Z', detail: null }],
      },
      features: {
        read_only: { enforceable: false },
        usage: { streaming: true, final_receipt: 'exact', fields: ['input_tokens', 'output_tokens'] },
        cancel: { control_message: true, grace_s: 10 },
        interaction: { modes: ['autonomous', 'interactive'], input: 'resume', holds_slot_while_waiting: false, mid_turn_input: false },
        model_reporting: 'final',
        effort_reporting: 'final',
        limits: { max_steps: true },
        forbidden_enforcement: [],
      },
      accounts: [
        {
          id: 'fake',
          status: 'available',
          quota: { state: 'ok', until: null, last_limit_hit_at: null },
          concurrency: { limit: 4, running: 0 },
          features_delta: {},
          admission: { status: 'admitted', features_sha256: '0'.repeat(64) },
          models: [
            {
              id: 'fake-high',
              tier: 'high',
              tier_source: 'runner_default',
              preferred_for_tier: true,
              aliases: [],
              efforts: ['default', 'low', 'medium', 'high'],
              default_effort: 'default',
              availability: 'verified',
              verified_at: '2026-11-27T00:00:00.000Z',
            },
          ],
        },
      ],
    },
  ];
}
