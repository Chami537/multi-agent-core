import { resolve, join } from 'node:path';
import { Runtime } from '../core/runtime.js';
import type { Run } from '../core/types.js';
import { candidateOutcome } from '../core/lifecycle.js';
import { workspaceState } from '../host/workspace.js';
import type { Store } from '../store/database.js';
import type { ProjectConfig, RulingRecord, RunMetadata } from './types.js';
import { validateReview, type ReviewReceipt } from './reviews.js';
import { checkInPlaceWorkspace, currentHead, prepareInPlace, prepareRunWorktree, resolveRunBase, restoreInPlace } from './worktree.js';

interface Preparation {
  branch: string;
  workspace: string;
  repo_root: string;
  base_sha: string;
  mode: 'worktree' | 'in_place';
  original_head: string | null;
  restored: boolean;
}
function preparation(store: Store, id: string): Preparation | null {
  const row = store.db.prepare('SELECT payload FROM api_start_preparations WHERE run_id=?').get(id) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as Preparation : null;
}
function savePreparation(store: Store, id: string, prep: Preparation): void {
  store.db.prepare('INSERT INTO api_start_preparations VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload').run(id, JSON.stringify(prep));
}

export function configureRunLifecycle(params: {
  runtime: Runtime;
  store: Store;
  projectMap: Map<string, ProjectConfig>;
  getRunMeta: (id: string) => RunMetadata | null;
}): void {
  const { runtime, store, projectMap, getRunMeta } = params;
  runtime.setPrepareStart((run, now) => {
    const meta = getRunMeta(run.id);
    const project = projectMap.get(run.projectId);
    if (!meta || !project) return;
    const repoRoot = resolve(project.workspace_path);
    if (meta.workspace_mode === 'in_place') {
      checkInPlaceWorkspace({ repoRoot, store, projectId: project.id, runId: run.id });
      // A preparation intent is also a root lease, including a queued run whose
      // Git checkout succeeded before the metadata/launch transaction failed.
      const rows = store.db.prepare('SELECT run_id, payload FROM api_start_preparations WHERE run_id!=?').all(run.id) as { run_id: string; payload: string }[];
      for (const row of rows) {
        const other = JSON.parse(row.payload) as Preparation;
        if (other.mode === 'in_place' && other.repo_root === repoRoot && !other.restored) throw new Error('in_place_lease_conflict');
      }
    }
    let prep = preparation(store, run.id);
    if (!prep) {
      prep = {
        branch: meta.branch, workspace: meta.workspace_mode === 'worktree' ? join(run.runDir, 'worktree') : repoRoot,
        repo_root: repoRoot, base_sha: resolveRunBase(repoRoot, meta.base), mode: meta.workspace_mode,
        original_head: meta.workspace_mode === 'in_place' ? currentHead(repoRoot) : null, restored: false,
      };
      // The intent fixes the exact base, target branch/directory and original
      // HEAD before the first Git mutation. Do not combine this with completion.
      store.transaction(() => savePreparation(store, run.id, prep!));
    }
    if (prep.mode === 'worktree') {
      prepareRunWorktree({ repoRoot: prep.repo_root, worktreePath: prep.workspace, branch: prep.branch, base: { kind: 'commit', sha: prep.base_sha } });
    } else {
      prepareInPlace(prep.repo_root, prep.branch, prep.base_sha);
      if (prep.restored) {
        prep.restored = false;
        store.transaction(() => savePreparation(store, run.id, prep!));
      }
    }
    meta.base.sha = prep.base_sha;
    meta.base.resolved_at = new Date(now).toISOString();
    meta.started_at ??= new Date(now).toISOString();
    store.transaction(() => {
      store.db.prepare('UPDATE api_runs SET payload=? WHERE id=?').run(JSON.stringify(meta), run.id);
    });
    return { workspace: prep.workspace };
  });
  runtime.setFinalizeHooks((run, now) => {
    const meta = getRunMeta(run.id);
    if (meta && ['review', 'audit'].includes(run.role) && candidateOutcome(run).state === 'done') {
      const receipt = validateReview(store, run, meta, projectMap.get(run.projectId)!.workspace_path);
      run.deliverableInvalid = !receipt.valid;
      store.db.prepare('INSERT INTO api_verdicts VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload').run(run.id, run.taskId, JSON.stringify(receipt));
      run.version++;
      store.emit('verdict.validated', { ...receipt, version: run.version }, run, now);
    }
    const prep = preparation(store, run.id);
    if (!prep || prep.mode !== 'in_place' || prep.restored || !prep.original_head) return;
    // After a crash following checkout restoration, the root HEAD is already
    // original. The run's branch remains the authority for its terminal head.
    run.workspaceHead = resolveRunBase(prep.repo_root, { kind: 'branch', ref: prep.branch, sha: null });
    if (run.preservation.state === 'failed') return;
    try { restoreInPlace(prep.repo_root, prep.original_head); }
    catch (error) {
      run.preservation = { ...run.preservation, state: 'failed', error: String(error) };
      return;
    }
    prep.restored = true;
    // The callback runs inside the terminal-state transaction.
    savePreparation(store, run.id, prep);
  }, (run, now) => {
    const meta = getRunMeta(run.id);
    if (!meta) return;
    meta.ended_at = new Date(now).toISOString();
    store.db.prepare('UPDATE api_runs SET payload=? WHERE id=?').run(JSON.stringify(meta), run.id);
    if (run.state !== 'done' || !run.workspaceHead || !meta.lineage || ['review', 'audit'].includes(run.role)) return;
    const rows = store.db.prepare('SELECT id, payload FROM api_runs WHERE task_id=?').all(run.taskId) as { id: string; payload: string }[];
    const members = rows.map(row => JSON.parse(row.payload) as RunMetadata).filter(m => m.lineage?.branch_id === meta.lineage!.branch_id);
    const branchVersion = Math.max(...members.map(m => m.lineage!.version)) + 1;
    const candidate = { run_id: run.id, sha: run.workspaceHead };
    for (const member of members) {
      member.lineage = { ...member.lineage!, candidate, version: branchVersion };
      store.db.prepare('UPDATE api_runs SET payload=? WHERE id=?').run(JSON.stringify(member), member.id);
      const changed = member.id === run.id ? run : store.get(member.id);
      changed.version++;
      if (changed.id !== run.id) store.put(changed);
      store.emit('run.updated', { version: changed.version, changes: { lineage: member.lineage } }, changed, now);
    }
    const reviews = store.db.prepare('SELECT run_id, payload FROM api_verdicts WHERE task_id=?').all(run.taskId) as { run_id: string; payload: string }[];
    for (const row of reviews) {
      const receipt = JSON.parse(row.payload) as ReviewReceipt;
      if (receipt.status !== 'effective' || !receipt.reviewed || receipt.reviewed.sha === candidate.sha || !members.some(m => m.id === receipt.reviewed!.run_id)) continue;
      receipt.status = 'superseded';
      store.db.prepare('UPDATE api_verdicts SET payload=? WHERE run_id=?').run(JSON.stringify(receipt), row.run_id);
      const review = store.get(row.run_id); review.version++; store.put(review);
      store.emit('verdict.superseded', { review_run_id: review.id, reviewed: receipt.reviewed, superseded_by: candidate, version: review.version }, review, now);
    }
    // Candidate advancement and invalidation share the run's terminal commit.
    const rulings = store.db.prepare('SELECT payload FROM api_rulings WHERE task_id=?').all(run.taskId) as { payload: string }[];
    for (const row of rulings) {
      const ruling = JSON.parse(row.payload) as RulingRecord;
      if (ruling.branch.id !== meta.lineage.branch_id || ruling.status !== 'effective') continue;
      ruling.status = 'superseded'; ruling.version++;
      store.db.prepare('UPDATE api_rulings SET payload=? WHERE id=?').run(JSON.stringify(ruling), ruling.id);
      store.emit('ruling.superseded', { ruling, version: ruling.version }, run, now);
    }
  });
}

export async function recoverStartPreparations(runtime: Runtime): Promise<void> {
  const rows = runtime.store.db.prepare('SELECT run_id FROM api_start_preparations').all() as { run_id: string }[];
  for (const row of rows) {
    const run = runtime.store.get(row.run_id);
    if (run.segment !== 0 || !['queued', 'leasing'].includes(run.state)) continue;
    try { runtime.start(run.id); }
    catch (error) {
      // Keep the durable intent for a later retry; never lose it or report a
      // phantom running process. Storage errors still surface to the caller.
      if (!(error instanceof Error) || error.message !== 'capacity_or_state_unavailable') throw error;
    }
  }
}

export function verifyRulingSubject(store: Store, run: Run, meta: RunMetadata, sha: string, project: ProjectConfig): string | null {
  if (!run.workspaceHead || sha !== run.workspaceHead) return 'Subject sha must equal the terminal head_sha';
  const candidate = meta.lineage?.candidate;
  if (!candidate || candidate.run_id !== run.id || candidate.sha !== sha) return 'Subject is no longer the current lineage candidate';
  try {
    const branchHead = resolveRunBase(resolve(project.workspace_path), { kind: 'branch', ref: meta.branch, sha: null });
    if (branchHead !== sha) return 'Recorded head_sha differs from the actual branch head';
    const prep = preparation(store, run.id);
    if ((!prep || prep.mode === 'worktree') && workspaceState(run.workspace).head !== sha) return 'Recorded head_sha differs from the actual workspace head';
  } catch { return 'Subject head cannot be verified in Git'; }
  return null;
}
