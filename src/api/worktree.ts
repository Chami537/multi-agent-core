import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Run } from '../core/types.js';
import type { Store } from '../store/database.js';
import type { ReleaseState } from './types.js';

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

export function getReleaseState(store: Store, runId: string): ReleaseState | null {
  const row = store.db.prepare('SELECT payload FROM api_worktree_releases WHERE run_id=?').get(runId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as ReleaseState) : null;
}

export function saveReleaseState(store: Store, runId: string, state: ReleaseState, now = Date.now()): void {
  store.db
    .prepare(
      `INSERT INTO api_worktree_releases(run_id, payload, updated_at) VALUES (?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
    )
    .run(runId, JSON.stringify(state), now);
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

  const refRes = git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
  if (refRes.status !== 0) {
    return { ok: false, reason: 'ref_not_found', message: `Preservation ref '${ref}' does not exist` };
  }
  const refSha = refRes.stdout.trim();

  if (branchTip) {
    const anc = git(repoRoot, ['merge-base', '--is-ancestor', branchTip, ref]);
    if (anc.status !== 0) {
      return { ok: false, reason: 'branch_tip_not_reachable', message: `Run branch tip ${branchTip} is not an ancestor of ${ref}` };
    }
  }
  if (wipSha) {
    const anc = git(repoRoot, ['merge-base', '--is-ancestor', wipSha, ref]);
    if (anc.status !== 0) {
      return { ok: false, reason: 'wip_not_reachable', message: `WIP sha ${wipSha} is not an ancestor of ${ref}` };
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
        // Determine whether ref changed or run branch moved
        let reason = 'preservation_ref_changed';
        if (verified.branch_tip) {
          const curTip = git(repoRoot, ['rev-parse', '--verify', '--quiet', verified.branch]);
          if (curTip.status !== 0 || curTip.stdout.trim() !== verified.branch_tip) {
            reason = 'run_branch_moved';
          }
        }
        const aborted: ReleaseState = {
          state: 'aborted',
          requested_at: getReleaseState(store, run.id)?.requested_at ?? new Date(now).toISOString(),
          released_at: null,
          error: { reason, message: tx.stderr.trim() || 'git update-ref transaction aborted' },
        };
        store.transaction(() => {
          const latest = store.get(run.id);
          latest.version++;
          store.put(latest);
          saveReleaseState(store, run.id, aborted, now);
          store.emit('run.updated', { version: latest.version, changes: { release: aborted } }, latest, now);
        });
        return;
      }
    }

    // Remove worktree directory if it is not the repo root itself
    if (existsSync(run.workspace) && resolve(run.workspace) !== resolve(repoRoot)) {
      git(repoRoot, ['worktree', 'remove', '--force', run.workspace]);
      if (existsSync(run.workspace)) {
        rmSync(run.workspace, { recursive: true, force: true });
      }
    }

    const completed: ReleaseState = {
      state: 'completed',
      requested_at: getReleaseState(store, run.id)?.requested_at ?? new Date(now).toISOString(),
      released_at: new Date(now).toISOString(),
      error: null,
    };
    store.transaction(() => {
      const latest = store.get(run.id);
      latest.version++;
      store.put(latest);
      saveReleaseState(store, run.id, completed, now);
      store.emit('run.updated', { version: latest.version, changes: { release: completed } }, latest, now);
    });
  });
}
