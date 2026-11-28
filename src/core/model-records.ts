import { nativeEffort } from './launch.js';
import type { Run } from './types.js';
import type { EffortThreeStageValue, RunMetadata, ThreeStageValue } from '../api/types.js';

export function buildModelAndEffortRecords(
  run: Run,
  meta: RunMetadata,
): { model_record: ThreeStageValue; effort_record: EffortThreeStageValue } {
  const resolved = run.state !== 'queued' && run.segment > 0;
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
    resolved: resolved ? (run.startResolution?.model ?? run.model) : null,
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
  const resolvedNative = resolved
    ? (run.startResolution ? run.startResolution.nativeEffort : nativeEffort(run.reasoningEffort))
    : null;
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

