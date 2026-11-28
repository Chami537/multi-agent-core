export type Operation = { op: string; [key: string]: unknown };
export interface Scenario { schema: 'mac.fake-scenario/0.2'; model_effective?: string | null; effort_effective?: string | null; native_session_id?: string | null; steps: Operation[] }
export function scenario(value: unknown): Scenario {
  if (typeof value === 'object' && value !== null) {
    const s = value as Scenario;
    if (s.schema !== 'mac.fake-scenario/0.2' || !Array.isArray(s.steps) || s.steps.some(o => !o || typeof o.op !== 'string')) throw new Error('invalid_scenario');
    const supported = new Set(['step','message','reasoning','tool','usage','sleep','await_input','fail','complete','ignore_sigterm','spawn_child','crash','native_crash','model_changed','emit_raw','hang']);
    for (const op of s.steps) if (!supported.has(op.op)) throw new Error(`not_implemented: scenario.${op.op}`);
    return s;
  }
  const name = typeof value === 'string' ? value.trim() : 'ok';
  const ops: Operation[] = [];
  if (name.startsWith('ok_slow:')) ops.push({ op: 'sleep', ms: Number(name.split(':')[1]) * 1000 });
  else if (name === 'ignore_term') ops.push({ op: 'ignore_sigterm' }, { op: 'hang' });
  else if (name === 'orphan') ops.push({ op: 'spawn_child', sleep_ms: 60_000 }, { op: 'complete' });
  else if (name === 'bad_protocol') ops.push({ op: 'emit_raw', line: 'bad JSON' }, { op: 'hang' });
  else if (name === 'steps_limit') { for (let i = 0; i < 100; i++) ops.push({ op: 'step' }, { op: 'tool', tool: 'shell', kind: 'shell', summary: 'fake', status: 'ok', duration_ms: 0 }); }
  else if (name.startsWith('interactive:')) { for (let i = 0; i < Number(name.split(':')[1]); i++) ops.push({ op: 'await_input', prompt: 'next?' }); }
  else if (name === 'fail') ops.push({ op: 'fail', error: { category: 'task', code: 'task_failed', message: 'scripted failure', retryable: false, scope: 'run', evidence: { source: 'fake' } }, work_started: true });
  else if (name !== 'ok' && !name.startsWith('ok_slow:')) throw new Error(`not_implemented_scenario: ${name}`);
  if (ops.length === 0 || name.startsWith('ok_slow:')) ops.push({ op: 'message', text: 'fake result' }, { op: 'tool', tool: 'shell', kind: 'shell', summary: 'fake check', status: 'ok', duration_ms: 1 }, { op: 'usage', input_tokens: 10, output_tokens: 5 });
  ops.push({ op: 'complete', final_message: 'complete' });
  return { schema: 'mac.fake-scenario/0.2', steps: ops };
}
