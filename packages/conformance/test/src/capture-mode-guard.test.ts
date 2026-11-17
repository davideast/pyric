import { describe, expect, it } from 'bun:test';
import {
  CAPTURE_WRITE_FLAGS,
  formatInertPreviewFooter,
  hasExplicitCaptureFlag,
  requireCaptureMode,
  stripCaptureFlags,
} from '../../src/capture-mode-guard.ts';

describe('capture-mode-guard', () => {
  it('requires an explicit --write or --capture flag before live capture', () => {
    expect(CAPTURE_WRITE_FLAGS).toEqual(['--write', '--capture']);
    expect(hasExplicitCaptureFlag([])).toBe(false);
    expect(hasExplicitCaptureFlag(['--scenario', 'foo'])).toBe(false);
    expect(hasExplicitCaptureFlag(['--probe=bar'])).toBe(false);
    expect(hasExplicitCaptureFlag(['--verify'])).toBe(false);
    expect(hasExplicitCaptureFlag(['--write'])).toBe(true);
    expect(hasExplicitCaptureFlag(['--capture'])).toBe(true);
    expect(hasExplicitCaptureFlag(['--scenario', 'foo', '--write'])).toBe(true);
    expect(hasExplicitCaptureFlag(['--capture', '--probe', 'bar'])).toBe(true);
  });

  it('strips --write and --capture flags without altering positional or selector arguments', () => {
    expect(stripCaptureFlags([])).toEqual([]);
    expect(stripCaptureFlags(['--write'])).toEqual([]);
    expect(stripCaptureFlags(['--capture'])).toEqual([]);
    expect(stripCaptureFlags(['--write', '--scenario', 'r15', '--capture'])).toEqual([
      '--scenario',
      'r15',
    ]);
    expect(stripCaptureFlags(['--write', 'rules-api'])).toEqual(['rules-api']);
  });

  it('formats a plain-ASCII inert preview footer naming --write', () => {
    const footer = formatInertPreviewFooter('packages/conformance/src/run-rules.ts');
    expect(footer).toContain('--write');
    expect(footer).toContain('packages/conformance/src/run-rules.ts');
    for (const ch of footer) {
      expect(ch.codePointAt(0) ?? 0).toBeLessThanOrEqual(127);
    }
  });

  it('exits 0 with inert preview without probing credentials when --write is absent', () => {
    let checkedCreds = false;
    const exitedCodes: number[] = [];
    expect(() =>
      requireCaptureMode({
        label: 'test-rig',
        scriptPath: 'packages/conformance/src/run-rules.ts',
        argv: ['--scenario', 'foo'],
        missingCredentials: () => {
          checkedCreds = true;
          return 'PYRIC_ORACLE_PROJECT_ID';
        },
        exit: (code) => {
          exitedCodes.push(code);
          throw new Error(`exit:${code}`);
        },
      }),
    ).toThrow('exit:0');
    expect(exitedCodes).toEqual([0]);
    expect(checkedCreds).toBe(false);
  });

  it('exits 1 naming missing configuration when --write is passed without credentials', () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));
    try {
      expect(() =>
        requireCaptureMode({
          label: 'test-rig',
          scriptPath: 'packages/conformance/src/run-rules.ts',
          argv: ['--write', '--scenario', 'foo'],
          missingCredentials: () => 'GOOGLE_APPLICATION_CREDENTIALS or firebase-tools login',
          exit: (code) => {
            throw new Error(`exit:${code}`);
          },
        }),
      ).toThrow('exit:1');
    } finally {
      console.error = origError;
    }
    expect(errors.join('\n')).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(errors.join('\n').toLowerCase()).not.toContain('inert preview');
  });

  it('returns stripped CLI arguments when --write and credentials are present', () => {
    const cleaned = requireCaptureMode({
      label: 'test-rig',
      scriptPath: 'packages/conformance/src/run-rules.ts',
      argv: ['--write', '--scenario', 'foo'],
      missingCredentials: () => null,
    });
    expect(cleaned).toEqual(['--scenario', 'foo']);
  });
});
