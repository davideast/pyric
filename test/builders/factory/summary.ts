/**
 * `factory-summary`: the timeline as the morning review reads it. Totals per
 * seat first, then every line in order, then the size of the run's work
 * trees (`<run>.work/`).
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TimelineLine } from './timeline.ts';

type SessionLine = Extract<TimelineLine, { type: 'session' }>;
type PauseLine = Extract<TimelineLine, { type: 'pause' }>;

const clockTime = (iso: string): string => iso.slice(11, 19);

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}

function span(start: string, end: string): number {
  return Date.parse(end) - Date.parse(start);
}

function seatTotals(sessions: readonly SessionLine[]): string[] {
  const seats = [...new Set(sessions.map((line) => line.seat))];
  return seats.map((seat) => {
    const own = sessions.filter((line) => line.seat === seat);
    const failed = own.filter((line) => line.endedBy === 'exit' && line.exitCode !== 0).length;
    const limited = own.filter((line) => line.endedBy === 'rate-limit').length;
    const working = own.reduce((total, line) => total + span(line.start, line.end), 0);
    return `  ${seat.padEnd(16)} ${String(own.length).padStart(3)} sessions  ${minutes(working).padStart(5)} working  ${failed} failed  ${limited} rate-limited`;
  });
}

function describeLine(line: TimelineLine): string {
  switch (line.type) {
    case 'start': return `${clockTime(line.at)}  start, deadline ${line.deadline}`;
    case 'restart': return `${clockTime(line.at)}  restart (last heartbeat ${line.lastHeartbeat === undefined ? 'none' : clockTime(line.lastHeartbeat)})`;
    case 'session': {
      const error = line.error === undefined ? '' : `  ${line.error}`;
      return `${clockTime(line.start)}-${clockTime(line.end)}  ${line.seat.padEnd(16)} ${line.endedBy} ${line.exitCode}  ${line.logPath}${error}`;
    }
    case 'pause': return `${clockTime(line.at)}  pause until ${clockTime(line.until)} (${line.seat}, ${line.source})`;
    case 'check': return `${clockTime(line.at)}  hourly check ${line.hour}: ${line.passed ? 'passed' : 'failed'}, ${line.summary}`;
    case 'end': return `${clockTime(line.at)}  deadline reached`;
  }
}

export function formatSummary(lines: readonly TimelineLine[]): string {
  const sessions = lines.filter((line): line is SessionLine => line.type === 'session');
  const pauses = lines.filter((line): line is PauseLine => line.type === 'pause');
  const restarts = lines.filter((line) => line.type === 'restart').length;
  const checks = lines.filter((line) => line.type === 'check');
  const passed = checks.filter((line) => line.type === 'check' && line.passed).length;
  const ended = lines.some((line) => line.type === 'end');
  const waited = pauses.reduce((total, line) => total + span(line.at, line.until), 0);
  return [
    `${sessions.length} sessions, ${restarts} restarts, ${pauses.length} pauses (${minutes(waited)} waiting), ${checks.length} hourly checks (${passed} passed), ${ended ? 'reached its deadline' : 'not at its deadline yet'}`,
    '',
    ...seatTotals(sessions),
    '',
    ...lines.map(describeLine),
  ].join('\n');
}

/** The bytes of every file under `path`, links not followed; 0 when there is nothing there. */
export function treeBytes(path: string): number {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + treeBytes(join(path, name)), 0);
}

/** One line on the size of the run's work trees, which the harness keeps. */
export function workSizeLine(workDir: string): string {
  const gigabytes = treeBytes(workDir) / 1024 ** 3;
  return `work trees: ${gigabytes.toFixed(1)} GB in ${workDir}; remove them by hand when no check is running`;
}
