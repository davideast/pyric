/**
 * `factory-check`: restarts a supervisor that has stopped beating. A systemd
 * timer runs it every few minutes. `Restart=on-failure` covers a supervisor
 * that exits or is killed; this covers one that hangs, whose process lives on
 * and whose heartbeat goes stale.
 */
import { spawnSync } from 'node:child_process';
import { hasRun, readHeartbeat, readRun, type RunPaths } from './run-dir.ts';

export type HeartbeatStatus = 'no-run' | 'over' | 'fresh' | 'stale';

export function heartbeatStatus(paths: RunPaths, now: number, staleMs: number): HeartbeatStatus {
  if (!hasRun(paths)) return 'no-run';
  const run = readRun(paths);
  if (now >= Date.parse(run.deadline)) return 'over';
  // With no heartbeat yet, the run's start stands in for the first one.
  const lastSign = readHeartbeat(paths)?.at ?? run.startedAt;
  return now - Date.parse(lastSign) > staleMs ? 'stale' : 'fresh';
}

export type RestartUnit = (unit: string) => { ok: boolean; detail: string };

export const systemctlRestart: RestartUnit = (unit) => {
  const result = spawnSync('systemctl', ['--user', 'restart', unit], { encoding: 'utf8' });
  const ok = result.status === 0;
  const detail = ok ? `restarted ${unit}` : `systemctl --user restart ${unit} failed: ${(result.stderr || String(result.error ?? '')).trim()}`;
  return { ok, detail };
};

/** Restarts `unit` when the run's heartbeat is stale. Exits non-zero only when a restart fails. */
export function checkSupervisor(paths: RunPaths, unit: string, staleMs: number, now: number, restart: RestartUnit = systemctlRestart): { exitCode: number; message: string } {
  const status = heartbeatStatus(paths, now, staleMs);
  if (status !== 'stale') return { exitCode: 0, message: `${paths.root}: ${status}` };
  const result = restart(unit);
  return { exitCode: result.ok ? 0 : 1, message: `${paths.root}: stale heartbeat; ${result.detail}` };
}
