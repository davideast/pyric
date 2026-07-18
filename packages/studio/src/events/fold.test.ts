/**
 * Session-scoped event-log folding (issue #359 extension): the one rule every
 * Studio accumulation applies so Settings → Reset also empties the
 * traffic/event surfaces. Pins the decision recorded in `fold.ts`: a reset
 * boundary keeps EXACTLY the boundary event; a dispose boundary appends.
 */
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { foldSessionEventLog, isSessionResetBoundary } from './fold.js';

function write(id: string): SandboxEvent {
  return { kind: 'write', id, at: 1, path: `notes/${id}` } as unknown as SandboxEvent;
}

function boundary(id: string, phase: 'reset' | 'dispose'): SandboxEvent {
  return {
    kind: 'session_boundary',
    id,
    at: 2,
    phase,
    priorOpCount: 3,
  } as unknown as SandboxEvent;
}

describe('foldSessionEventLog', () => {
  it('appends ordinary events', () => {
    const log = foldSessionEventLog([write('a')], write('b'));
    expect(log.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('a reset boundary drops the wiped session, keeping only the boundary (pinned)', () => {
    let log: readonly SandboxEvent[] = [];
    for (const e of [write('a'), write('b'), boundary('r1', 'reset')]) {
      log = foldSessionEventLog(log, e);
    }
    expect(log.map((e) => e.id)).toEqual(['r1']);
    // The next session accumulates on top of the marker.
    log = foldSessionEventLog(log, write('c'));
    expect(log.map((e) => e.id)).toEqual(['r1', 'c']);
  });

  it('a dispose boundary does NOT clear — dispose closes, it does not wipe', () => {
    const log = foldSessionEventLog([write('a')], boundary('d1', 'dispose'));
    expect(log.map((e) => e.id)).toEqual(['a', 'd1']);
  });
});

describe('isSessionResetBoundary', () => {
  it('matches only session_boundary events with phase reset', () => {
    expect(isSessionResetBoundary(boundary('r', 'reset'))).toBe(true);
    expect(isSessionResetBoundary(boundary('d', 'dispose'))).toBe(false);
    expect(isSessionResetBoundary(write('w'))).toBe(false);
  });
});
