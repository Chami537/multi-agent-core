import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../core/types.js';
import type { Store } from '../store/database.js';
import type { RunMetadata } from './types.js';
import { commitContainsFile } from './worktree.js';

export interface ReviewReceipt {
  valid: boolean;
  reviewed: { run_id: string; sha: string } | null;
  status: 'effective' | 'superseded';
  errors: string[];
}
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, min = 0, max = Infinity): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const fields = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const oneOf = (v: unknown, values: string[]) => typeof v === 'string' && values.includes(v);
const runId = (v: unknown) => text(v) && /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(v);

// This receipt is derived by the host from verdict.json, never from a runner's
// claimed status or from a client-provided based_on entry.
export function validateReview(store: Store, run: Run, meta: RunMetadata, repoRoot: string): ReviewReceipt {
  const errors: string[] = [];
  let verdict: unknown;
  try { verdict = JSON.parse(readFileSync(join(run.runDir, 'artifacts', 'verdict.json'), 'utf8')); }
  catch { errors.push('Missing or malformed verdict.json'); }
  const receipt: ReviewReceipt = { valid: false, reviewed: null, status: 'superseded', errors };
  if (!object(verdict)) { errors.push('Verdict must be an object'); return receipt; }
  const reviewed = verdict.reviewed;
  if (!object(reviewed) || !fields(reviewed, ['run_id', 'sha']) || !runId(reviewed.run_id) || !text(reviewed.sha) || !/^[0-9a-f]{40}$/.test(reviewed.sha)) {
    errors.push('Invalid reviewed subject'); return receipt;
  }
  receipt.reviewed = { run_id: reviewed.run_id as string, sha: reviewed.sha };
  if (meta.review_of?.run_id !== reviewed.run_id || meta.review_of?.sha !== reviewed.sha) errors.push('Verdict differs from review_of');
  const sourceRow = store.db.prepare('SELECT payload FROM api_runs WHERE id=? AND task_id=?').get(receipt.reviewed.run_id, run.taskId) as { payload: string } | undefined;
  const source = sourceRow ? JSON.parse(sourceRow.payload) as RunMetadata : null;
  if (!source) errors.push('Reviewed run is not in the task');
  if (!fields(verdict, ['schema', 'reviewed', 'overall', 'summary', 'items']) || verdict.schema !== 'mac.verdict/0.2'
    || !oneOf(verdict.overall, ['PASS', 'PASS_WITH_NOTES', 'FAIL']) || !text(verdict.summary, 0, 8192)
    || !Array.isArray(verdict.items) || verdict.items.length === 0) errors.push('Invalid verdict schema');
  const ids = new Set<string>();
  let failed = 0, majorFailed = false;
  for (const item of Array.isArray(verdict.items) ? verdict.items : []) {
    if (!object(item)) { errors.push('Invalid item'); continue; }
    if (!fields(item, ['id', 'title', 'result', 'severity', 'detail', 'evidence']) || !text(item.id, 1, 32) || ids.has(item.id)
      || !text(item.title, 1, 200) || !oneOf(item.result, ['pass', 'fail', 'note', 'na'])
      || (item.detail !== undefined && !text(item.detail, 0, 16384))) errors.push('Invalid item schema or duplicate id');
    if (text(item.id)) ids.add(item.id);
    if ((oneOf(item.result, ['fail', 'note']) || item.severity !== undefined) && !oneOf(item.severity, ['blocker', 'major', 'minor', 'info'])) errors.push('Invalid severity');
    if (item.result === 'fail') { failed++; majorFailed ||= oneOf(item.severity, ['blocker', 'major']); }
    if ((item.result === 'fail' && (!Array.isArray(item.evidence) || item.evidence.length === 0)) || (item.evidence !== undefined && !Array.isArray(item.evidence))) errors.push('Invalid evidence array');
    for (const evidence of Array.isArray(item.evidence) ? item.evidence : []) {
      if (!object(evidence)) { errors.push('Invalid evidence'); continue; }
      let valid = false;
      if (evidence.kind === 'file') {
        const path = evidence.path;
        valid = fields(evidence, ['kind', 'path', 'lines', 'at']) && text(path, 1) && !path.startsWith('/') && !path.split('/').includes('..')
          && (evidence.lines === undefined || (text(evidence.lines) && /^[0-9]+(-[0-9]+)?$/.test(evidence.lines)))
          && (evidence.at === undefined || oneOf(evidence.at, ['reviewed', 'base']));
        if (valid) {
          const sha = evidence.at === 'base' ? source?.base.sha : receipt.reviewed.sha;
          valid = Boolean(sha) && commitContainsFile(repoRoot, sha!, path as string);
        }
      } else if (evidence.kind === 'command') valid = fields(evidence, ['kind', 'cmd', 'exit_code', 'excerpt']) && text(evidence.cmd, 1) && Number.isSafeInteger(evidence.exit_code) && (evidence.excerpt === undefined || text(evidence.excerpt, 0, 8192));
      else if (evidence.kind === 'event') valid = fields(evidence, ['kind', 'run_id', 'seq']) && runId(evidence.run_id) && Number.isSafeInteger(evidence.seq) && Number(evidence.seq) >= 1;
      else if (evidence.kind === 'url') valid = fields(evidence, ['kind', 'url', 'excerpt']) && text(evidence.url, 1) && (evidence.excerpt === undefined || text(evidence.excerpt, 0, 8192));
      if (!valid) errors.push('Invalid evidence schema or missing file at commit');
    }
  }
  if ((verdict.overall === 'PASS' && failed > 0) || (verdict.overall === 'FAIL' && failed === 0) || (verdict.overall === 'PASS_WITH_NOTES' && majorFailed)) errors.push('Inconsistent overall verdict');
  receipt.valid = errors.length === 0;
  receipt.status = receipt.valid && source?.lineage?.candidate?.sha === reviewed.sha ? 'effective' : 'superseded';
  return receipt;
}

export function getReviewReceipt(store: Store, id: string): ReviewReceipt | null {
  const row = store.db.prepare('SELECT payload FROM api_verdicts WHERE run_id=?').get(id) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as ReviewReceipt : null;
}
