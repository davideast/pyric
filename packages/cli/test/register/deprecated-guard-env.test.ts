import { describe, expect, it } from 'bun:test';
import {
  warnDeprecatedGuardEnv,
  warnDeprecatedGuardEnvOnce,
} from '../../src/register/deprecated-guard-env.js';

describe('warnDeprecatedGuardEnv', () => {
  it('stays silent and returns false when neither PYRIC_GUARD nor PYRIC_GUARD_ALLOW is set', () => {
    const lines: string[] = [];
    expect(warnDeprecatedGuardEnv({}, (line) => lines.push(line))).toBe(false);
    expect(
      warnDeprecatedGuardEnv(
        { PYRIC_GUARD: '', PYRIC_GUARD_ALLOW: '   ' },
        (line) => lines.push(line),
      ),
    ).toBe(false);
    expect(lines).toEqual([]);
  });

  it('writes a single deprecation warning naming PYRIC_GUARD when set', () => {
    const lines: string[] = [];
    expect(warnDeprecatedGuardEnv({ PYRIC_GUARD: 'warn' }, (line) => lines.push(line))).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('PYRIC_GUARD');
    expect(lines[0]).not.toContain('PYRIC_GUARD_ALLOW');
    expect(lines[0]).toContain('deprecated');
    expect(lines[0]).toContain('swap-or-stop');
    expect(lines[0]!.endsWith('\n')).toBe(true);
  });

  it('writes a single deprecation warning naming PYRIC_GUARD_ALLOW when set', () => {
    const lines: string[] = [];
    expect(
      warnDeprecatedGuardEnv(
        { PYRIC_GUARD_ALLOW: 'api.example.com' },
        (line) => lines.push(line),
      ),
    ).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('PYRIC_GUARD_ALLOW');
    expect(lines[0]).toContain('deprecated');
    expect(lines[0]!.endsWith('\n')).toBe(true);
  });

  it('names both variables in one line when both are set', () => {
    const lines: string[] = [];
    expect(
      warnDeprecatedGuardEnv(
        { PYRIC_GUARD: 'off', PYRIC_GUARD_ALLOW: 'api.example.com' },
        (line) => lines.push(line),
      ),
    ).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('PYRIC_GUARD and PYRIC_GUARD_ALLOW');
    expect(lines[0]!.split('\n').filter(Boolean)).toHaveLength(1);
  });
});

describe('warnDeprecatedGuardEnvOnce', () => {
  it('emits at most once per slot', () => {
    const lines: string[] = [];
    const slot: Record<symbol, unknown> = {};
    expect(
      warnDeprecatedGuardEnvOnce({ PYRIC_GUARD: 'block' }, (line) => lines.push(line), slot),
    ).toBe(true);
    expect(
      warnDeprecatedGuardEnvOnce({ PYRIC_GUARD: 'block' }, (line) => lines.push(line), slot),
    ).toBe(false);
    expect(lines).toHaveLength(1);
  });
});
