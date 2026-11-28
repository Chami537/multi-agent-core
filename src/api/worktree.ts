import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Run } from '../core/types.js';
import type { Store } from '../store/database.js';
import type { ProjectConfig, ReleaseState, RunMetadata } from './types.js';

const GIT_ENV = { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };

function git(cwd: string, args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('/usr/bin/git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    input,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export interface PersistedReleaseRecord {
  release: ReleaseState;
  verified?: VerifyResult['verified'];
  progress?: {
    ref_tx_done: boolean;
    dir_removed: boolean;
  };
}

export function getReleaseRecord(store: Store, runId: string): PersistedReleaseRecord | null {
  const row = store.db.prepare('SELECT payload FROM api_worktree_releases WHERE run_id=?').get(runId) as { payload: string } | undefined;
  if (!row) return null;
  const parsed = JSON.parse(row.payload) as PersistedReleaseRecord | ReleaseState;
  if ('release' in parsed) return parsed;
  return { release: parsed };
}

export function getReleaseState(store: Store, runId: string): ReleaseState | null {
  return getReleaseRecord(store, runId)?.release ?? null;
}

export function saveReleaseRecord(store: Store, runId: string, record: PersistedReleaseRecord, now = Date.now()): void {
  store.db
    .prepare(
      `INSERT INTO api_worktree_releases(run_id, payload, updated_at) VALUES (?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
    )
    .run(runId, JSON.stringify(record), now);
}

export function saveReleaseState(store: Store, runId: string, state: ReleaseState, now = Date.now()): void {
  const existing = getReleaseRecord(store, runId);
  saveReleaseRecord(store, runId, { ...existing, release: state }, now);
}

export interface VerifyResult {
  ok: true;
  verified: {
    kind: 'reachable_from' | 'discard';
    branch: string;
    branch_tip: string | null;
    wip_sha: string | null;
    ref: string | null;
    ref_sha: string | null;
  };
}

export type VerifyError = { ok: false; reason: string; message: string };

export function verifyWorktreePreservation(params: {
  repoRoot: string;
  run: Run;
  runBranch: string;
  runBranchPrefix: string;
  preservation: Record<string, unknown>;
}): VerifyResult | VerifyError {
  const { repoRoot, run, runBranch, runBranchPrefix, preservation } = params;
  const kind = preservation.kind;

  const fullRunBranch = runBranch.startsWith('refs/') ? runBranch : `refs/heads/${runBranch}`;
  const tipRes = git(repoRoot, ['rev-parse', '--verify', '--quiet', fullRunBranch]);
  const branchTip = tipRes.status === 0 ? tipRes.stdout.trim() : null;
  const wipSha = run.preservation.sha ?? null;

  if (kind === 'discard') {
    const ack = preservation.ack;
    if (ack !== `DISCARD ${run.id}`) {
      return { ok: false, reason: 'discard_ack_mismatch', message: `discard requires ack: "DISCARD ${run.id}"` };
    }
    return {
      ok: true,
      verified: { kind: 'discard', branch: fullRunBranch, branch_tip: branchTip, wip_sha: wipSha, ref: null, ref_sha: null },
    };
  }

  if (kind !== 'reachable_from') {
    return { ok: false, reason: 'invalid_preservation_kind', message: 'preservation.kind must be reachable_from or discard' };
  }

  const ref = preservation.ref;
  if (typeof ref !== 'string' || (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/'))) {
    return { ok: false, reason: 'invalid_ref_format', message: 'ref must be a full ref name (refs/heads/... or refs/tags/...)' };
  }

  const normalizedPrefix = runBranchPrefix.endsWith('/') ? runBranchPrefix : `${runBranchPrefix}/`;
  if (ref === fullRunBranch || ref.startsWith(`refs/heads/${normalizedPrefix}`)) {
    return { ok: false, reason: 'ref_in_deletion_namespace', message: 'preservation ref cannot be the run branch or under the run branch namespace' };
  }

  const refRes = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (refRes.status !== 0) {
    return { ok: false, reason: 'ref_not_found', message: `Preservation ref '${ref}' does not exist` };
  }
  const refSha = refRes.stdout.trim();

  if (branchTip) {
    const anc = git(repoRoot, ['merge-base', '--is-ancestor', branchTip, refSha]);
    if (anc.status !== 0) {
      return { ok: false, reason: 'branch_tip_not_reachable', message: `Run branch tip ${branchTip} is not an ancestor of ${refSha}` };
    }
  }
  if (wipSha) {
    const anc = git(repoRoot, ['merge-base', '--is-ancestor', wipSha, refSha]);
    if (anc.status !== 0) {
      return { ok: false, reason: 'wip_not_reachable', message: `WIP sha ${wipSha} is not an ancestor of ${refSha}` };
    }
  }

  if (existsSync(run.workspace)) {
    const st = git(run.workspace, ['status', '--porcelain', '--untracked-files=all']);
    if (st.status !== 0 || st.stdout.length > 0) {
      return { ok: false, reason: 'dirty_worktree', message: 'Worktree directory has uncommitted changes or untracked files' };
    }
  }

  return {
    ok: true,
    verified: { kind: 'reachable_from', branch: fullRunBranch, branch_tip: branchTip, wip_sha: wipSha, ref, ref_sha: refSha },
  };
}

const repoLocks = new Map<string, Promise<void>>();

async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(repoRoot);
  const prev = repoLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(r => { release = r; });
  repoLocks.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (repoLocks.get(key) === next) repoLocks.delete(key);
  }
}

export async function executeWorktreeRelease(params: {
  store: Store;
  repoRoot: string;
  run: Run;
  verified: VerifyResult['verified'];
}): Promise<void> {
  const { store, repoRoot, run, verified } = params;
  await withRepoLock(repoRoot, async () => {
    const now = Date.now();
    const currentRecord = getReleaseRecord(store, run.id);
    if (currentRecord && (currentRecord.release.state === 'completed' || currentRecord.release.state === 'aborted')) {
      return;
    }
    const progress = currentRecord?.progress ?? { ref_tx_done: false, dir_removed: false };
    const requestedAt = currentRecord?.release.requested_at ?? new Date(now).toISOString();

    if (!progress.ref_tx_done) {
      // Build atomic git update-ref --stdin transaction
      const cmds: string[] = [];
      if (verified.kind === 'reachable_from' && verified.ref && verified.ref_sha) {
        cmds.push(`verify ${verified.ref} ${verified.ref_sha}`);
      }
      if (verified.branch_tip) {
        cmds.push(`delete ${verified.branch} ${verified.branch_tip}`);
      }

      if (cmds.length > 0) {
        const tx = git(repoRoot, ['update-ref', '--stdin'], `${cmds.join('\n')}\n`);
        if (tx.status !== 0) {
          let reason = 'preservation_ref_changed';
          if (verified.branch_tip) {
            const curTip = git(repoRoot, ['rev-parse', '--verify', '--quiet', verified.branch]);
            if (curTip.status !== 0 || curTip.stdout.trim() !== verified.branch_tip) {
              reason = 'run_branch_moved';
            }
          }
          const aborted: ReleaseState = {
            state: 'aborted',
            requested_at: requestedAt,
            released_at: null,
            error: { reason, message: tx.stderr.trim() || 'git update-ref transaction aborted' },
          };
          store.transaction(() => {
            const latest = store.get(run.id);
            latest.version++;
            store.put(latest);
            saveReleaseRecord(store, run.id, { release: aborted, verified, progress }, now);
            store.emit('run.updated', { version: latest.version, changes: { release: aborted } }, latest, now);
          });
          return;
        }
      }

      progress.ref_tx_done = true;
      store.transaction(() => {
        saveReleaseRecord(
          store,
          run.id,
          {
            release: currentRecord?.release ?? { state: 'pending', requested_at: requestedAt, released_at: null, error: null },
            verified,
            progress,
          },
          now,
        );
      });
    }

    // Remove worktree directory if it is not the repo root itself
    if (!progress.dir_removed) {
      if (existsSync(run.workspace) && resolve(run.workspace) !== resolve(repoRoot)) {
        git(repoRoot, ['worktree', 'remove', '--force', run.workspace]);
        if (existsSync(run.workspace)) {
          rmSync(run.workspace, { recursive: true, force: true });
        }
      }
      progress.dir_removed = true;
    }

    const completed: ReleaseState = {
      state: 'completed',
      requested_at: requestedAt,
      released_at: new Date(now).toISOString(),
      error: null,
    };
    store.transaction(() => {
      const latest = store.get(run.id);
      latest.version++;
      store.put(latest);
      saveReleaseRecord(store, run.id, { release: completed, verified, progress }, now);
      store.emit('run.updated', { version: latest.version, changes: { release: completed } }, latest, now);
    });
  });
}

export async function recoverWorktreeReleases(params: {
  store: Store;
  projectMap: Map<string, ProjectConfig>;
}): Promise<void> {
  const { store, projectMap } = params;
  const rows = store.db.prepare('SELECT run_id, payload FROM api_worktree_releases').all() as { run_id: string; payload: string }[];
  for (const row of rows) {
    const rec = JSON.parse(row.payload) as PersistedReleaseRecord | ReleaseState;
    if (!('release' in rec) || rec.release.state !== 'pending' || !rec.verified) continue;
    let run: Run;
    try {
      run = store.get(row.run_id);
    } catch {
      continue;
    }
    const project = projectMap.get(run.projectId);
    if (!project) continue;
    await executeWorktreeRelease({
      store,
      repoRoot: resolve(project.workspace_path),
      run,
      verified: rec.verified,
    });
  }
}

export function prepareRunWorktree(params: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  base: { kind: string; ref?: string; sha: string | null };
}): { baseSha: string } {
  const { repoRoot, worktreePath, branch, base } = params;
  const isGit = git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (isGit.status !== 0) {
    throw new Error(`workspace_not_git_repo: ${repoRoot}`);
  }
  const target = base.sha ?? (base.ref ? `refs/heads/${base.ref}` : 'HEAD');
  let resolved = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`]);
  if (resolved.status !== 0 && base.ref) {
    resolved = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${base.ref}^{commit}`]);
  }
  if (resolved.status !== 0) {
    throw new Error(`base_ref_not_found: ${target}`);
  }
  const baseSha = resolved.stdout.trim();
  mkdirSync(dirname(worktreePath), { recursive: true, mode: 0o700 });
  if (existsSync(worktreePath)) {
    git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
  }
  const fullBranch = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
  const addRes = git(repoRoot, ['worktree', 'add', '-b', fullBranch, worktreePath, baseSha]);
  if (addRes.status !== 0) {
    throw new Error(`worktree_create_failed: ${addRes.stderr.trim() || addRes.stdout.trim()}`);
  }
  return { baseSha };
}

export function checkInPlaceWorkspace(params: {
  repoRoot: string;
  store: Store;
  projectId: string;
  runId: string;
}): void {
  const { repoRoot, store, projectId, runId } = params;
  const active = store.list().filter(
    r => r.id !== runId && r.projectId === projectId && ['leasing', 'running', 'waiting'].includes(r.state),
  );
  for (const r of active) {
    const row = store.db.prepare('SELECT payload FROM api_runs WHERE id=?').get(r.id) as { payload: string } | undefined;
    if (!row) continue;
    const meta = JSON.parse(row.payload) as RunMetadata;
    if (meta.workspace_mode === 'in_place') {
      throw new Error('in_place_lease_conflict');
    }
  }
  const isGit = git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (isGit.status === 0) {
    const st = git(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
    if (st.status !== 0 || st.stdout.length > 0) {
      throw new Error('in_place_workspace_dirty');
    }
  }
}
