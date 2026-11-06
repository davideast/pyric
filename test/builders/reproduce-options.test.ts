import { describe, expect, test } from 'bun:test';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { UsageError } from './cli-args.ts';
import { tarballMismatches } from './provenance.ts';
import { linkProblem } from './repro-app.ts';
import { reproPhase } from './reproduce.ts';
import { DEFAULT_MINUTES, parseReproduceOptions } from './reproduce-options.ts';
import { phaseSchema } from './run-phase.ts';

describe('parseReproduceOptions', () => {
  test('reads a reproduction', () => {
    const parsed = parseReproduceOptions(['r1', 'r1-1-haiku-5-5', 'google-host:firestore.googleapis.com', '--script', 'repro.mjs', '--expect', 'permission-denied', '--register']);
    expect(parsed).toEqual({
      list: false,
      round: 'r1',
      run: 'r1-1-haiku-5-5',
      problem: 'google-host:firestore.googleapis.com',
      script: resolve('repro.mjs'),
      expect: 'permission-denied',
      register: true,
      minutes: DEFAULT_MINUTES,
    });
  });

  test('reads --list', () => {
    expect(parseReproduceOptions(['r1', 'run-a', '--list'])).toEqual({ list: true, round: 'r1', run: 'run-a' });
  });

  test('refuses what it cannot run', () => {
    const bad = [
      ['r1', 'run-a', 'p1'],
      ['r1', 'run-a', 'p1', '--script', 'repro.ts'],
      ['r1', 'run-a', '--script', 'repro.mjs'],
      ['R1', 'run-a', 'p1', '--script', 'repro.mjs'],
      ['r1', '../x', 'p1', '--script', 'repro.mjs'],
      ['r1', 'run-a', 'p1', '--script', 'repro.mjs', '--minutes', '61'],
      ['r1', 'run-a', 'p1', '--script', 'repro.mjs', '--model', 'x'],
      ['r1', 'run-a', 'p1', '--list'],
    ];
    for (const args of bad) expect(() => parseReproduceOptions(args)).toThrow(UsageError);
  });
});

describe('reproPhase', () => {
  test('runs node on the script with no model channel', () => {
    const phase = reproPhase('pyric-repro.mjs', { register: true, minutes: 2, problem: 'p1' });
    expect(phaseSchema.parse(phase)).toEqual(phase);
    expect(phase).toMatchObject({ command: 'node', args: ['--import', '@pyric/cli/register', 'pyric-repro.mjs'], wallClockMs: 120_000, modelChannel: false, log: 'repro.log' });
    expect(Object.keys(phase.env)).toEqual(['PYRIC_REPRO_PROBLEM']);
  });
});

describe('tarballMismatches', () => {
  test('names each package whose tarball differs from the run\'s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repro-tarballs-'));
    const file = join(dir, 'cli.tgz');
    writeFileSync(file, 'tarball');
    const sha = '4ef0c8e0e8fd6d3e3c6c8a4bfe4bb4d81c41e9a6c6e2f7ad0b4ab5e05ae03e5a';
    const tarballs = new Map([['@pyric/cli', file]]);
    expect(tarballMismatches({ '@pyric/cli': sha, '@pyric/ui': sha }, tarballs)).toEqual([
      expect.stringMatching(/^@pyric\/cli is [0-9a-f]{12}, the run installed 4ef0c8e0e8fd$/),
      '@pyric/ui has no tarball here',
    ]);
  });
});

describe('linkProblem', () => {
  test('refuses a link where the harness writes outside the sandbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repro-app-'));
    writeFileSync(join(dir, 'package.json'), '{}');
    symlinkSync('/etc/hostname', join(dir, 'firebase-config.js'));
    symlinkSync(dir, join(dir, 'app'));
    expect(linkProblem(join(dir, 'package.json'), 'file')).toBeUndefined();
    expect(linkProblem(join(dir, 'absent.js'), 'file')).toBeUndefined();
    expect(linkProblem(join(dir, 'firebase-config.js'), 'file')).toContain('is not a plain file');
    expect(linkProblem(join(dir, 'app'), 'directory')).toContain('is not a plain directory');
    expect(linkProblem(dir, 'directory')).toBeUndefined();
  });
});
