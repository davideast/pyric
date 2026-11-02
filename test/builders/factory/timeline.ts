/**
 * `timeline.jsonl`: what happened in a run, one line per event, appended and
 * never rewritten. A session's line is written when it ends. `factory-summary`
 * reads it for the morning review.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { EndedBy, Role } from './session.ts';

export type TimelineLine =
  | { type: 'start'; at: string; deadline: string; pid: number }
  /** A supervisor resumed the run; `lastHeartbeat` is the previous one's last sign of life. */
  | { type: 'restart'; at: string; deadline: string; pid: number; lastHeartbeat?: string }
  | {
    type: 'session';
    seat: string;
    role: Role;
    prompt: string;
    start: string;
    end: string;
    endedBy: EndedBy;
    exitCode: number;
    logPath: string;
    /** The runner threw instead of returning a result. */
    error?: string;
  }
  | { type: 'pause'; at: string; until: string; seat: string; source: 'reset-at' | 'backoff' }
  | { type: 'check'; at: string; hour: number; passed: boolean; summary: string }
  | { type: 'end'; at: string };

export function appendTimeline(path: string, line: TimelineLine): void {
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}

/** The timeline's lines, skipping any a crash cut short. */
export function readTimeline(path: string): TimelineLine[] {
  if (!existsSync(path)) return [];
  const lines: TimelineLine[] = [];
  for (const text of readFileSync(path, 'utf8').split('\n')) {
    if (text.trim() === '') continue;
    try {
      lines.push(JSON.parse(text) as TimelineLine);
    } catch {
      // A line cut short by a crash.
    }
  }
  return lines;
}
