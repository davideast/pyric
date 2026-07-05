/**
 * Tests for confirm-prompt.ts — render + parse logic only.
 * Real /dev/tty interaction is exercised in the integration test
 * (handler-level), not here.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseKey,
  renderPrompt,
  formatArgs,
} from '../../src/bridge/server/confirm-prompt.js';

describe('parseKey', () => {
  test('y/Y → approve', () => {
    expect(parseKey('y')).toBe('approve');
    expect(parseKey('Y')).toBe('approve');
  });
  test('n/N → deny', () => {
    expect(parseKey('n')).toBe('deny');
    expect(parseKey('N')).toBe('deny');
  });
  test('a (lowercase only) → approve-tool', () => {
    expect(parseKey('a')).toBe('approve-tool');
    // Capital A should NOT be approve-tool — too easy to hit by accident.
    expect(parseKey('A')).toBe('unknown');
  });
  test('D (uppercase only) → deny-all', () => {
    expect(parseKey('D')).toBe('deny-all');
    // Lowercase d should NOT trigger session-wide deny.
    expect(parseKey('d')).toBe('unknown');
  });
  test('garbage → unknown', () => {
    expect(parseKey('z')).toBe('unknown');
    expect(parseKey('1')).toBe('unknown');
    expect(parseKey(' ')).toBe('unknown');
    expect(parseKey('\n')).toBe('unknown');
  });
});

describe('formatArgs', () => {
  test('pretty-prints small objects', () => {
    const out = formatArgs({ a: 1, b: 'two' });
    expect(out).toContain('"a": 1');
    expect(out).toContain('"b": "two"');
  });

  test('indents continuation lines under the label', () => {
    const out = formatArgs({ nested: { x: 1 } });
    const lines = out.split('\n');
    // First line should NOT have the indent; later lines should.
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).not.toMatch(/^ {10}/);
    expect(lines[1]).toMatch(/^ {10}/);
  });

  test('truncates payloads larger than 2KB', () => {
    const big = { huge: 'x'.repeat(10_000) };
    const out = formatArgs(big);
    expect(out.length).toBeLessThan(2500);
    expect(out).toContain('truncated');
  });

  test('survives unstringifiable values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = formatArgs(circular);
    // Should produce SOMETHING rather than throwing.
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('renderPrompt', () => {
  const baseReq = {
    tool: 'firestore_update_document',
    args: { path: 'users/u1', data: { name: 'Alice' } },
    project: 'my-app',
    policy: 'always' as const,
    now: () => new Date('2026-05-24T14:32:08Z'),
    useColor: false,
  };

  test('contains header with timestamp and project', () => {
    const out = renderPrompt(baseReq);
    expect(out).toContain('14:32:08');
    expect(out).toContain('CONFIRM TOOL CALL');
    expect(out).toContain('my-app');
  });

  test('shows tool name', () => {
    const out = renderPrompt(baseReq);
    expect(out).toContain('firestore_update_document');
  });

  test('shows args pretty-printed', () => {
    const out = renderPrompt(baseReq);
    expect(out).toContain('users/u1');
    expect(out).toContain('"name": "Alice"');
  });

  test('uses ⛔ icon for delete tools', () => {
    const out = renderPrompt({ ...baseReq, tool: 'firestore_delete_document' });
    expect(out).toContain('⛔');
  });

  test('uses ⚠ icon for non-delete tools', () => {
    const out = renderPrompt(baseReq);
    expect(out).toContain('⚠');
    expect(out).not.toContain('⛔');
  });

  test('includes asUser line when supplied', () => {
    const out = renderPrompt({ ...baseReq, asUser: 'user-123' });
    expect(out).toContain('As user:');
    expect(out).toContain('user-123');
  });

  test('omits asUser line when null/absent', () => {
    const out = renderPrompt(baseReq);
    expect(out).not.toContain('As user:');
  });

  test('shows [a] approve-tool option for always policy', () => {
    const out = renderPrompt(baseReq);
    expect(out).toMatch(/\[a\].*approve all/);
  });

  test('hides [a] for session policy (already cached)', () => {
    const out = renderPrompt({ ...baseReq, policy: 'session' });
    expect(out).not.toMatch(/\[a\].*approve all/);
  });

  test('always shows [D] kill switch', () => {
    const out = renderPrompt(baseReq);
    expect(out).toMatch(/\[D\].*DENY everything/);
  });

  test('useColor:false produces no ANSI escape codes', () => {
    const out = renderPrompt(baseReq);
    expect(out).not.toMatch(/\x1b\[/);
  });

  test('useColor:true produces ANSI escape codes', () => {
    const out = renderPrompt({ ...baseReq, useColor: true });
    expect(out).toMatch(/\x1b\[/);
  });

  test('includes diff lines when provided', () => {
    const out = renderPrompt({
      ...baseReq,
      diff: ['- old line', '+ new line'],
    });
    expect(out).toContain('Diff:');
    expect(out).toContain('- old line');
    expect(out).toContain('+ new line');
  });
});
