/** Denial-walkthrough model — why-rows, fix prompt. */
import { describe, test, expect } from 'bun:test';
import {
  buildFixPrompt,
  buildWhyRows,
  parseInspectDenialResult,
  toDenialBlurb,
  type InspectDenialData,
} from './denial-walkthrough';
import type { DenialBlurb } from '~/lib/store/runtime';

const FULL: InspectDenialData = {
  denial: {
    at: 1718000000000,
    op: 'create pyric_sessions/test',
    path: 'pyric_sessions/test',
    method: 'create',
    auth: '{"uid":"alice"}',
    message: 'Missing or insufficient permissions',
  },
};

describe('parseInspectDenialResult', () => {
  test('round-trips the tool payload and rejects garbage', () => {
    expect(parseInspectDenialResult(JSON.stringify(FULL))?.denial?.path).toBe(
      'pyric_sessions/test',
    );
    expect(parseInspectDenialResult(undefined)).toBeNull();
    expect(parseInspectDenialResult('not json')).toBeNull();
    expect(parseInspectDenialResult('"a string"')).toBeNull();
  });
});

describe('buildWhyRows', () => {
  test('reading order: request, auth, message', () => {
    const rows = buildWhyRows(FULL.denial!);
    expect(rows.map((r) => r.label)).toEqual([
      'request',
      'auth',
      'simulator said',
    ]);
    expect(rows[0]!.value).toBe('create pyric_sessions/test');
  });

  test('sparse denial degrades without empty rows', () => {
    const rows = buildWhyRows({ op: 'update todos/a' });
    expect(rows.map((r) => r.label)).toEqual(['request', 'auth']);
    expect(rows[0]!.value).toBe('update todos/a');
    expect(rows[1]!.value).toBe('(unknown)');
  });
});

describe('buildFixPrompt', () => {
  test('carries the evidence and the bounded three-case instruction', () => {
    const p = buildFixPrompt(FULL);
    expect(p).toContain('create pyric_sessions/test');
    expect(p).toContain('{"uid":"alice"}');
    // The agent must be allowed to conclude "working as intended".
    expect(p).toContain('change NOTHING');
    expect(p).toContain('MINIMAL edit');
    expect(p).toContain('/workspace/firestore.rules');
  });
});

describe('toDenialBlurb', () => {
  const live: DenialBlurb = {
    id: 'real',
    at: 1718000000000,
    op: 'create pyric_sessions/test',
    auth: '{"uid":"alice"}',
    message: 'Missing or insufficient permissions',
    request: { request: { method: 'create', path: 'pyric_sessions/test', resource: { data: { a: 1 } } } },
  };

  test('prefers the live runtime-store blurb (full request envelope)', () => {
    const b = toDenialBlurb(FULL, [live]);
    expect(b.id).toBe('real');
    expect((b.request as { request: { resource?: unknown } }).request.resource).toBeDefined();
  });

  test('synthesizes a minimal blurb when the store rolled past it', () => {
    const b = toDenialBlurb(FULL, []);
    expect(b.id).toStartWith('synth-');
    expect(b.op).toBe('create pyric_sessions/test');
  });
});
