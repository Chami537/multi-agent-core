import { move, recordCandidate, requestStop } from './lifecycle.js';
import { emptyUsage, type Finished, type Run, type RunnerEvent, type Usage } from './types.js';
import { aggregateUsage, counters } from './usage.js';

export function applyEvent(run: Run, event: RunnerEvent, now: number): void {
  if (run.candidate) { run.protocolViolation = 'output after run.finished'; return; }
  if (event.type === 'session.started') {
    if (!['native_session_id','model','reasoning_effort','native_version'].every(k => k in event.data)) throw new Error('invalid_session_started');
    if (event.data.model && typeof event.data.model === 'object' && !Array.isArray(event.data.model)) {
      run.reportedModel = { ...(event.data.model as Record<string, unknown>) };
    }
    if (event.data.reasoning_effort && typeof event.data.reasoning_effort === 'object' && !Array.isArray(event.data.reasoning_effort)) {
      run.reportedEffort = { ...(event.data.reasoning_effort as Record<string, unknown>) };
    }
  }
  if (event.type === 'model.changed') {
    if (event.data.model && typeof event.data.model === 'object' && !Array.isArray(event.data.model)) run.reportedModel = { ...run.reportedModel, ...(event.data.model as Record<string, unknown>) };
    if (event.data.reasoning_effort && typeof event.data.reasoning_effort === 'object' && !Array.isArray(event.data.reasoning_effort)) run.reportedEffort = { ...run.reportedEffort, ...(event.data.reasoning_effort as Record<string, unknown>) };
  }
  if (event.type === 'tool.call' || event.type === 'file.changed') run.hadWorkEvents = true;
  let usageChanged = false;
  if (event.type === 'usage' || event.type === 'run.finished') {
    const usage = (event.type === 'usage' ? event.data : event.data.usage) as unknown as Usage;
    if (!usage || !('input_tokens' in usage) || !('steps' in usage) || !['exact','partial','unknown'].includes(usage.completeness) || !usage.basis || !usage.extra || !('native_cost_usd' in usage) || !('native_cumulative' in usage)) throw new Error('invalid_usage');
    const previous = run.segmentUsage[run.segment] ?? emptyUsage();
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'steps', 'turns'] as const) {
      const value = usage[key];
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error('invalid_usage');
      if (previous[key] !== null && (value === null || value < previous[key]!)) throw new Error('usage_regressed');
    }
    usageChanged = counters.some(k => previous[k] !== usage[k]) || JSON.stringify(previous.extra) !== JSON.stringify(usage.extra);
    run.segmentUsage[run.segment] = usage; run.usage = aggregateUsage(run.segmentUsage);
    // Internal D1 backstop; public budget fields remain gated until Phase 3.
    if (run.maxSteps !== null && usage.steps !== null && usage.steps > run.maxSteps - run.previousSteps && !run.stop) requestStop(run, 'budget', now);
  }
  if (event.type === 'input.requested') {
    if (run.inputMode !== 'stdin' || run.state !== 'running') throw new Error('unexpected_input_request');
    move(run, 'waiting', 'awaiting_input', 'T9', now);
  }
  if (event.type === 'run.finished') {
    const data = event.data as unknown as Finished;
    const required = ['outcome','error','work_started','final_message','usage','model','reasoning_effort','steps','turns','resume_token','native_session_id','native_exit'];
    if (!required.every(k => k in event.data) || !['completed', 'awaiting_input', 'failed', 'cancelled'].includes(data.outcome)
      || typeof data.work_started !== 'boolean' || (data.final_message !== null && typeof data.final_message !== 'string')
      || !data.model || !data.reasoning_effort || (data.outcome === 'failed' && typeof data.error?.code !== 'string')
      || (data.outcome !== 'failed' && data.error !== null)) throw new Error('invalid_finished');
    if (data.outcome === 'awaiting_input' && (run.inputMode !== 'resume' || !data.resume_token)) throw new Error('invalid_resume_candidate');
    if (data.model && typeof data.model === 'object' && !Array.isArray(data.model)) {
      run.reportedModel = { ...(data.model as Record<string, unknown>) };
    }
    if (data.reasoning_effort && typeof data.reasoning_effort === 'object' && !Array.isArray(data.reasoning_effort)) {
      run.reportedEffort = { ...(data.reasoning_effort as Record<string, unknown>) };
    }
    recordCandidate(run, data, now);
  }
  if (run.state === 'running' && (['session.started','message','reasoning','tool.call','tool.result','file.changed','model.changed','turn.completed','native.unknown'].includes(event.type) || usageChanged)) run.clocks.idleSince = now;
}
