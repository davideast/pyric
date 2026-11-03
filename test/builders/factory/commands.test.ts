import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { UsageError } from '../cli-args.ts';
import { factoryHourCommand } from './app-commands.ts';
import { factoryCommand } from './commands.ts';
import { parseCheckOptions, parseFactoryOptions } from './options.ts';
import { pauseAfterRateLimit } from './rate-limit.ts';
import { AGENT_NAMES } from './agents/registry.ts';
import { createRun, runPaths, writeHeartbeat } from './run-dir.ts';
import { formatSummary } from './summary.ts';
import type { TimelineLine } from './timeline.ts';
import { checkSupervisor, heartbeatStatus } from './watchdog.ts';

const START = Date.parse('2026-11-01T22:00:00.000Z');
const MINUTE = 60_000;

describe('parseFactoryOptions', () => {
  test('takes hours to start, resume to go on, or both', () => {
    expect(parseFactoryOptions(['--run-dir', 'night', '--hours', '8'])).toEqual({ runDir: resolve('night'), hours: 8, resume: false });
    expect(parseFactoryOptions(['--run-dir', 'night', '--resume'])).toEqual({ runDir: resolve('night'), resume: true });
    expect(parseFactoryOptions(['--run-dir', 'night', '--hours', '0.5', '--resume', '--runner', 'r.ts'])).toEqual({ runDir: resolve('night'), hours: 0.5, resume: true, runner: resolve('r.ts') });
  });

  test('takes an agent the registry knows and a brief directory, resolved', () => {
    const agent = AGENT_NAMES[0] ?? '';
    expect(parseFactoryOptions(['--run-dir', 'night', '--hours', '8', '--agent', agent, '--brief-dir', 'brief'])).toEqual({ runDir: resolve('night'), hours: 8, resume: false, agent, briefDir: resolve('brief') });
    expect(() => parseFactoryOptions(['--run-dir', 'night', '--hours', '8', '--agent', 'no-such-agent'])).toThrow(UsageError);
  });

  test('refuses a missing run directory, neither hours nor resume, and hours out of range', () => {
    expect(() => parseFactoryOptions(['--hours', '8'])).toThrow(new UsageError('--run-dir is required'));
    expect(() => parseFactoryOptions(['--run-dir', 'night'])).toThrow(UsageError);
    for (const hours of ['0', '25', '-1', 'eight', '1e1']) expect(() => parseFactoryOptions(['--run-dir', 'night', '--hours', hours])).toThrow(UsageError);
    expect(() => parseFactoryOptions(['--run-dir', 'night', '--resume', 'extra'])).toThrow(new UsageError('unexpected arguments: extra'));
  });
});

describe('PYRIC_FACTORY_SERVE_HOST', () => {
  test('a bad serve address stops factory and factory-hour before anything runs', async () => {
    const before = process.env.PYRIC_FACTORY_SERVE_HOST;
    const runDir = join(mkdtempSync(join(tmpdir(), 'factory-serve-host-')), 'never-made');
    process.env.PYRIC_FACTORY_SERVE_HOST = '::ffff:0.0.0.0';
    try {
      expect(await factoryCommand(['--run-dir', runDir, '--hours', '1'])).toBe(2);
      expect(await factoryHourCommand(['--run-dir', runDir, '--hour', '1'])).toBe(2);
      expect(existsSync(runDir)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.PYRIC_FACTORY_SERVE_HOST;
      else process.env.PYRIC_FACTORY_SERVE_HOST = before;
    }
  });
});

describe('parseCheckOptions', () => {
  test('takes a unit and a staleness in minutes, five by default', () => {
    expect(parseCheckOptions(['--run-dir', 'night', '--unit', 'pyric-factory'])).toEqual({ runDir: resolve('night'), unit: 'pyric-factory', staleMinutes: 5 });
    expect(() => parseCheckOptions(['--run-dir', 'night', '--unit', 'a b'])).toThrow(UsageError);
    expect(() => parseCheckOptions(['--run-dir', 'night', '--unit', 'u', '--stale-minutes', '1'])).toThrow(UsageError);
  });
});

describe('pauseAfterRateLimit', () => {
  test('waits for the reset time, or backs off doubling, never past the deadline', () => {
    const deadline = START + 60 * MINUTE;
    expect(pauseAfterRateLimit(new Date(START + 10 * MINUTE).toISOString(), 1, START, deadline)).toEqual({ until: START + 10 * MINUTE, source: 'reset-at' });
    expect(pauseAfterRateLimit(undefined, 1, START, deadline)).toEqual({ until: START + MINUTE, source: 'backoff' });
    expect(pauseAfterRateLimit('not a time', 3, START, deadline)).toEqual({ until: START + 4 * MINUTE, source: 'backoff' });
    expect(pauseAfterRateLimit(new Date(START - MINUTE).toISOString(), 1, START, deadline)).toEqual({ until: START + MINUTE, source: 'backoff' });
    expect(pauseAfterRateLimit(new Date(START + 2 * 60 * MINUTE).toISOString(), 1, START, deadline)).toEqual({ until: deadline, source: 'reset-at' });
    expect(pauseAfterRateLimit(undefined, 20, START, deadline).until).toBe(START + 30 * MINUTE);
  });
});

describe('factory-check', () => {
  test('restarts the unit only when the heartbeat is stale and the run is not over', () => {
    const paths = runPaths(mkdtempSync(join(tmpdir(), 'factory-check-')));
    const restarted: string[] = [];
    const restart = (unit: string) => {
      restarted.push(unit);
      return { ok: true, detail: `restarted ${unit}` };
    };
    expect(heartbeatStatus(paths, START, 5 * MINUTE)).toBe('no-run');
    createRun(paths, { hours: 1, agent: 'fake', briefDir: '/briefs/narrations' }, START);
    expect(heartbeatStatus(paths, START + 4 * MINUTE, 5 * MINUTE)).toBe('fresh');
    writeHeartbeat(paths, START + 10 * MINUTE, 1);
    expect(checkSupervisor(paths, 'pyric-factory', 5 * MINUTE, START + 12 * MINUTE, restart).exitCode).toBe(0);
    expect(restarted).toEqual([]);
    expect(checkSupervisor(paths, 'pyric-factory', 5 * MINUTE, START + 16 * MINUTE, restart)).toEqual({ exitCode: 0, message: `${paths.root}: stale heartbeat; restarted pyric-factory` });
    expect(restarted).toEqual(['pyric-factory']);
    expect(heartbeatStatus(paths, START + 60 * MINUTE, 5 * MINUTE)).toBe('over');
    expect(checkSupervisor(paths, 'pyric-factory', 5 * MINUTE, START + 16 * MINUTE, () => ({ ok: false, detail: 'no bus' })).exitCode).toBe(1);
  });
});

describe('formatSummary', () => {
  test('totals each seat, then lists the timeline', () => {
    const at = (minutes: number): string => new Date(START + minutes * MINUTE).toISOString();
    const lines: TimelineLine[] = [
      { type: 'start', at: at(0), deadline: at(120), pid: 1 },
      { type: 'session', seat: 'lead', role: 'lead', prompt: 'p', start: at(0), end: at(10), endedBy: 'exit', exitCode: 0, logPath: 'logs/lead-1.log' },
      { type: 'session', seat: 'builder-1', role: 'builder', prompt: 'p', start: at(10), end: at(12), endedBy: 'rate-limit', exitCode: 1, logPath: 'logs/b-1.log' },
      { type: 'pause', at: at(12), until: at(42), seat: 'builder-1', source: 'reset-at' },
      { type: 'check', at: at(60), hour: 1, passed: true, summary: 'all good' },
      { type: 'restart', at: at(70), deadline: at(120), pid: 2, lastHeartbeat: at(64) },
      { type: 'end', at: at(120) },
    ];
    expect(formatSummary(lines)).toBe([
      '2 sessions, 1 restarts, 1 pauses (30m waiting), 1 hourly checks (1 passed), reached its deadline',
      '',
      '  lead               1 sessions    10m working  0 failed  0 rate-limited',
      '  builder-1          1 sessions     2m working  0 failed  1 rate-limited',
      '',
      '22:00:00  start, deadline 2026-11-02T00:00:00.000Z',
      '22:00:00-22:10:00  lead             exit 0  logs/lead-1.log',
      '22:10:00-22:12:00  builder-1        rate-limit 1  logs/b-1.log',
      '22:12:00  pause until 22:42:00 (builder-1, reset-at)',
      '23:00:00  hourly check 1: passed, all good',
      '23:10:00  restart (last heartbeat 23:04:00)',
      '00:00:00  deadline reached',
    ].join('\n'));
  });
});
