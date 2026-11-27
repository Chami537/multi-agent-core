import { spawnSync } from 'node:child_process';
export function workspaceState(cwd: string): { head: string | null; clean: boolean | null } {
  const options = { cwd, env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' as const, timeout: 2_000, maxBuffer: 1024 * 1024 };
  const head = spawnSync('/usr/bin/git', ['rev-parse','--verify','HEAD'], options);
  const status = spawnSync('/usr/bin/git', ['status','--porcelain','--untracked-files=all'], options);
  return { head: head.status === 0 ? head.stdout.trim() : null, clean: status.status === 0 ? status.stdout.length === 0 : null };
}
