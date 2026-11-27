import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidState } from '../dist/core/lifecycle.js';
import { alive, identity, signalProcess } from '../dist/host/process.js';
import { cleanup, launchFixture, makeRuntime, prompt, state, until, workspace } from './helpers/runtime.js';

afterEach(cleanup);

describe('D1 microfix regressions', () => {
  it.each([
    ['cancel', null, 'cancelled', 'supervisor_cancel'],
    ['timeout', 'timeout_total', 'interrupted', 'timeout_total'],
    ['timeout', 'timeout_waiting', 'interrupted', 'timeout_waiting'],
  ] as const)('N1: %s (%s) wins after complete is acknowledged without a candidate', async (kind, reason, expected, expectedReason) => {
    const rt = makeRuntime(), r = launchFixture(rt, 'complete-hang');
    const configured = rt.store.get(r.id); configured.inputMode = 'stdin'; rt.store.transaction(() => rt.store.put(configured));
    await state(rt, r.id, 'waiting'); rt.complete(r.id);
    await until(async () => {
      await rt.tick();
      return rt.store.db.prepare("SELECT delivered FROM commands WHERE run_id=? AND command_id='complete'").get(r.id)?.delivered === 1;
    });
    expect(rt.store.get(r.id)).toMatchObject({ finalizing: true, candidate: null, stop: null });
    expect(rt.host.facts(r.runDir, 1).endpointAlive).toBe(true);
    // Exercise timeout stop requests through the same guard; complete stops the waiting clock by protocol.
    expect(() => rt.stop(r.id, kind, Date.now(), false, reason)).not.toThrow();
    const ended = await state(rt, r.id, expected);
    expect(ended.reason).toBe(expectedReason); expect(ended.stop?.kind).toBe(kind);
    expect(ended.preservation.state).toBe(kind === 'cancel' ? 'not_required' : 'saved');
    expect(rt.host.facts(r.runDir, 1).groupAlive).toBe(false);
  });

  it('N3: cleanup kills a TERM-ignoring grandchild born after the leader exited and its recorded parent died', async () => {
    const rt = makeRuntime(), r = launchFixture(rt, 'late-orphan');
    await until(() => rt.host.status(r.runDir, 1)?.endpointExited === true && existsSync(join(r.workspace, 'late-child.json')));
    const status = rt.host.status(r.runDir, 1)!, childPid = JSON.parse(readFileSync(join(r.workspace, 'late-child.json'), 'utf8')).pid as number;
    expect(status.group?.members.some(member => member.pid === childPid)).toBe(true);
    writeFileSync(join(r.workspace, 'spawn-grandchild'), 'go');
    await until(() => existsSync(join(r.workspace, 'late-grandchild.json')));
    const grandchild = identity(JSON.parse(readFileSync(join(r.workspace, 'late-grandchild.json'), 'utf8')).pid as number);
    try {
      await until(() => status.group!.members.every(member => !alive(member)));
      expect(status.endpointExited).toBe(true); expect(alive(grandchild)).toBe(true);
      expect(status.group!.members.some(member => member.pid === grandchild.pid)).toBe(false);
      expect(rt.host.facts(r.runDir, 1).groupAlive).toBe(true);
      await rt.tick(); const termAt = rt.store.get(r.id).cleanupTermAt;
      expect(termAt).not.toBeNull(); expect(alive(grandchild)).toBe(true);
      await rt.tick(termAt! + 70);
      const ended = await state(rt, r.id, 'failed');
      expect(ended.reason).toBe('protocol_violation'); expect(ended.groupEmpty).toBe(true);
      expect(alive(grandchild)).toBe(false); expect(rt.host.facts(r.runDir, 1).groupAlive).toBe(false);
    } finally {
      signalProcess(grandchild, 'SIGKILL'); await until(() => !alive(grandchild));
    }
  });

  it('N2: a run-session capabilities error falls back to SIGTERM without a protocol violation', async () => {
    const rt = makeRuntime(), r = launchFixture(rt, 'capabilities-error');
    const protocol = join(rt.host.directory(r.runDir, 1), 'protocol.ndjson');
    await until(() => existsSync(protocol) && readFileSync(protocol, 'utf8').includes('session.started'));
    await rt.tick();
    expect(rt.store.get(r.id)).toMatchObject({ state: 'running', candidate: null, protocolViolation: null });
    expect(rt.host.status(r.runDir, 1)?.cancel).toBeNull();
    rt.stop(r.id); const ended = await state(rt, r.id, 'cancelled');
    expect(ended.protocolViolation).toBeNull(); expect(ended.reason).toBe('supervisor_cancel');
    expect(readFileSync(join(r.workspace, 'term.json'), 'utf8')).toBe('received');
    expect(existsSync(join(r.workspace, 'cancel.json'))).toBe(false);
    expect(ended.stop?.sentAt).not.toBeNull();
  });

  it.each(['supervisor_pause', 'step_limit_reached'])('K4: pause of a run already paused by %s throws InvalidState without mutation', async source => {
    const rt = makeRuntime(), r = rt.create({ workspace: workspace(rt), fakeMaxSteps: source === 'step_limit_reached' ? 1 : null,
      prompt: prompt(source === 'step_limit_reached' ? 'steps_limit' : { schema: 'mac.fake-scenario/0.2', steps: [{ op: 'step' }, { op: 'hang' }] }) });
    rt.start(r.id);
    if (source === 'supervisor_pause') {
      await until(async () => { await rt.tick(); return rt.store.get(r.id).usage.steps === 1; }); rt.stop(r.id, 'pause');
    }
    const paused = await state(rt, r.id, 'paused'), high = rt.store.meta().high;
    expect(() => rt.stop(r.id, 'pause')).toThrow(InvalidState);
    expect(() => rt.stop(r.id, 'pause')).toThrow('invalid_state: paused');
    expect(rt.store.get(r.id)).toEqual(paused); expect(rt.store.meta().high).toBe(high);
  });
});
