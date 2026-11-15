/**
 * Standing check for CLI help, bare tool listing, unknown-method hints, and
 * safe `pyric sandbox` launcher disambiguation.
 *
 * Enumerates every route in `SERVICE_COMMANDS`, every bare tool in `TOOLS`,
 * and every top-level CLI command so a newly added command or method record
 * cannot ship without focused `--help` or silently launch a server.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { METHODS, TOOLS } from '../../../src/bridge/surface/methods/registry.js';
import { parseArgs } from '../../../src/cli/index.js';
import { checkAmbiguousSandboxWord } from '../../../src/cli/sandbox-word-guard.js';
import { SERVICE_COMMANDS } from '../../../src/cli/service-commands.generated.js';
import { runDispatch, type CliRun } from '../../cli/run-cli.js';

const PACKAGE_ROOT = resolve(import.meta.dir, '../../..');
const DIST_CLI = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

const TOP_LEVEL_COMMANDS: ReadonlyArray<readonly string[]> = [
  ['bridge'],
  ['sandbox'],
  ['sandbox', 'salvage'],
  ['sandbox', 'seed-from-live'],
  ['run'],
  ['init'],
  ['vendor'],
  ['mcp'],
  ['snapshot'],
  ['verify'],
  ['verify', 'cases'],
  ['verify', 'staging', 'init'],
  ['verify', 'staging', 'restore'],
  ['can-i-use'],
  ['assurance', 'derive'],
];

const ASSURANCE_DERIVE_FLAGS: readonly string[] = [
  '--port',
  '--url',
  '--root',
  '--campaign-id',
  '--fail-on',
  '--include-heuristic',
  '--no-static',
  '--json',
];

async function runInTempDir(args: string[]): Promise<{ result: CliRun; createdPyricDir: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-help-route-'));
  const priorCwd = process.cwd();
  process.chdir(dir);
  try {
    const result = await runDispatch(args);
    return {
      result,
      createdPyricDir: existsSync(join(dir, '.pyric')),
    };
  } finally {
    process.chdir(priorCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CLI help and routing enumeration', () => {
  it('lists every registered surface tool in global pyric --help', async () => {
    const { result, createdPyricDir } = await runInTempDir(['--help']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(createdPyricDir).toBe(false);
    for (const tool of TOOLS) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+(?:pyric )?${tool.name}\\b`, 'm'));
    }
  });

  it('gives every route in SERVICE_COMMANDS focused --help without side effects', async () => {
    const methodByKey = new Map(METHODS.map((method) => [method.key, method]));
    for (const command of SERVICE_COMMANDS) {
      const route = [...command.path];
      const routeLabel = `pyric ${route.join(' ')}`;
      for (const flag of ['--help', '-h']) {
        const { result, createdPyricDir } = await runInTempDir([...route, flag]);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(createdPyricDir).toBe(false);
        expect(result.stdout).toContain(routeLabel);
        expect(result.stdout).not.toContain('pyric bridge [flags]');
        expect(result.stdout).not.toMatch(/Serving from|Local server:/);
      }
      if (route.length === 2) {
        const key = `${route[0]}.${route[1]}`;
        const { result } = await runInTempDir([...route, '--help']);
        if (key === 'assurance.derive') {
          for (const flagName of ASSURANCE_DERIVE_FLAGS) {
            expect(result.stdout).toContain(flagName);
          }
          expect(result.stdout).toContain('pyric assurance derive --campaign-id audit-pass');
          expect(result.stdout).not.toContain('--campaignId');
          expect(result.stdout).not.toContain('--in-process');
          expect(result.stdout).not.toContain('--allow-production');
          continue;
        }
        const method = methodByKey.get(key);
        if (method !== undefined) {
          const argNames = Object.keys(method.args.shape);
          for (const argName of argNames) {
            expect(result.stdout).toContain(`--${argName}`);
          }
        }
      }
    }
  });

  it('gives every top-level command focused --help without starting a server', async () => {
    for (const route of TOP_LEVEL_COMMANDS) {
      const routeLabel = `pyric ${route.join(' ')}`;
      for (const flag of ['--help', '-h']) {
        const { result, createdPyricDir } = await runInTempDir([...route, flag]);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(createdPyricDir).toBe(false);
        expect(result.stdout).toContain(routeLabel);
        expect(result.stdout).not.toMatch(/Serving from|Local server:/);
        if (route[0] !== 'bridge') {
          expect(result.stdout).not.toContain('pyric bridge [flags]');
        }
      }
    }
  });

  it('lists methods cleanly for every bare tool word and every <tool> --help', async () => {
    for (const tool of TOOLS) {
      const { result: helpResult, createdPyricDir: helpCreated } = await runInTempDir([tool.name, '--help']);
      expect(helpResult.code).toBe(0);
      expect(helpResult.stderr).toBe('');
      expect(helpCreated).toBe(false);
      expect(helpResult.stdout).toContain(`pyric ${tool.name}`);
      for (const method of tool.methods) {
        expect(helpResult.stdout).toContain(method.method);
      }

      if (tool.name === 'sandbox') continue;
      const { result: bareResult, createdPyricDir: bareCreated } = await runInTempDir([tool.name]);
      expect(bareResult.code).toBe(0);
      expect(bareResult.stderr).toBe('');
      expect(bareCreated).toBe(false);
      expect(bareResult.stdout).toContain(`pyric ${tool.name}`);
      expect(bareResult.stderr).not.toContain('unknown command');
      for (const method of tool.methods) {
        expect(bareResult.stdout).toContain(method.method);
      }
    }
  });

  it('suggests the closest valid method for unknown methods on known tools', async () => {
    const cases: Array<{ argv: string[]; expected: string }> = [
      { argv: ['firestore', 'setDocument'], expected: 'setDoc' },
      { argv: ['assurance', 'driv'], expected: 'derive' },
      { argv: ['database', 'sett'], expected: 'set' },
      { argv: ['ai_logic', 'stats'], expected: 'status' },
    ];
    for (const testCase of cases) {
      const { result, createdPyricDir } = await runInTempDir(testCase.argv);
      expect(result.code).toBe(1);
      expect(createdPyricDir).toBe(false);
      expect(result.stderr).toContain(testCase.expected);
      expect(result.stdout).not.toContain('pyric bridge [flags]');
    }
  });

  it('never launches a server for ambiguous or mistyped pyric sandbox <word> invocations', async () => {
    for (const argv of [
      ['sandbox', 'snapshot', '--help'],
      ['sandbox', 'snapshot', '-h'],
      ['sandbox', 'event', '--help'],
      ['sandbox', 'bogus', '--help'],
    ]) {
      const { result, createdPyricDir } = await runInTempDir(argv);
      expect(result.code).toBe(1);
      expect(createdPyricDir).toBe(false);
      expect(result.stdout).not.toMatch(/Serving from|Local server:/);
      expect(result.stderr).not.toMatch(/Serving from|Local server:/);
    }

    const refusals: Array<{ argv: string[]; hint: string }> = [
      { argv: ['sandbox', 'snapshot'], hint: 'pyric snapshot' },
      { argv: ['sandbox', 'serve'], hint: 'pyric serve --help' },
      { argv: ['sandbox', 'event'], hint: 'events' },
      { argv: ['sandbox', 'listcaptures'], hint: 'listCaptures' },
      { argv: ['sandbox', 'bogus'], hint: '--' },
    ];
    for (const refusal of refusals) {
      const { result, createdPyricDir } = await runInTempDir(refusal.argv);
      expect(result.code).toBe(1);
      expect(createdPyricDir).toBe(false);
      expect(result.stdout).not.toMatch(/Serving from|Local server:/);
      expect(result.stderr).toContain(refusal.hint);
      expect(result.stderr).toContain('--');
    }

    for (const nonMatch of ['help', 'list', 'status', 'bogus']) {
      const { result, createdPyricDir } = await runInTempDir(['sandbox', nonMatch]);
      expect(result.code).toBe(1);
      expect(createdPyricDir).toBe(false);
      expect(result.stderr).not.toContain('Did you mean');
      expect(result.stderr).toContain(`pyric sandbox -- ${nonMatch}`);
    }
  });

  it('passes real PATH executables, local bin executables, and explicit paths through sandbox parsing', () => {
    const explicit = parseArgs(['sandbox', '--', 'npm', 'run', 'dev', '-h']);
    expect(explicit.flags.has('h')).toBe(false);
    expect(explicit.passthrough).toEqual(['npm', 'run', 'dev', '-h']);

    const multiWord = parseArgs(['sandbox', 'npm', 'run', 'dev', '-h']);
    expect(multiWord.flags.has('h')).toBe(false);
    expect(multiWord.positional).toEqual(['npm', 'run', 'dev', '-h']);

    const nodeHelp = parseArgs(['sandbox', 'node', '--help']);
    expect(nodeHelp.flags.has('help')).toBe(false);
    expect(nodeHelp.positional).toEqual(['node', '--help']);
    expect(checkAmbiguousSandboxWord(nodeHelp)).toBeNull();

    const scriptHelp = parseArgs(['sandbox', './myscript.sh', '--help']);
    expect(scriptHelp.flags.has('help')).toBe(false);
    expect(scriptHelp.positional).toEqual(['./myscript.sh', '--help']);
    expect(checkAmbiguousSandboxWord(scriptHelp)).toBeNull();

    for (const cmd of [
      ['sandbox', 'sort', 'file.txt'],
      ['sandbox', 'test', '-f', 'a'],
      ['sandbox', 'sed', '-n', '1p'],
    ]) {
      expect(checkAmbiguousSandboxWord(parseArgs(cmd))).toBeNull();
    }

    const dir = mkdtempSync(join(tmpdir(), 'pyric-local-bin-'));
    try {
      const binDir = join(dir, 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      const vitePath = join(binDir, 'vite');
      writeFileSync(vitePath, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(vitePath, 0o755);
      const viteHelp = parseArgs(['sandbox', 'vite', '--help']);
      expect(viteHelp.flags.has('help')).toBe(false);
      expect(checkAmbiguousSandboxWord(viteHelp, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const methodHelp = parseArgs(['sandbox', 'events', '--help']);
    expect(methodHelp.flags.get('help')).toBe(true);
    expect(methodHelp.positional).toEqual(['events']);

    const salvageHelp = parseArgs(['sandbox', 'salvage', '--help']);
    expect(salvageHelp.flags.get('help')).toBe(true);
    expect(salvageHelp.positional).toEqual(['salvage']);

    const seedFromLiveHelp = parseArgs(['sandbox', 'seed-from-live', '--help']);
    expect(seedFromLiveHelp.flags.get('help')).toBe(true);
    expect(seedFromLiveHelp.positional).toEqual(['seed-from-live']);
  });

  it('exercises the real built CLI binary end-to-end for help, bare tools, and sandbox refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-cli-smoke-'));
    try {
      const runBuilt = (args: string[]) =>
        spawnSync('node', [DIST_CLI, ...args], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 30_000,
        });

      const methodHelp = runBuilt(['firestore', 'getDoc', '--help']);
      expect(methodHelp.status).toBe(0);
      expect(methodHelp.stderr).toBe('');
      expect(methodHelp.stdout).toContain('pyric firestore getDoc');
      expect(methodHelp.stdout).toContain('--path');

      const deriveHelp = runBuilt(['assurance', 'derive', '--help']);
      expect(deriveHelp.status).toBe(0);
      expect(deriveHelp.stderr).toBe('');
      expect(deriveHelp.stdout).toContain('--campaign-id');
      expect(deriveHelp.stdout).not.toContain('--campaignId');

      const bareAssurance = runBuilt(['assurance']);
      expect(bareAssurance.status).toBe(0);
      expect(bareAssurance.stderr).toBe('');
      expect(bareAssurance.stdout).toContain('pyric assurance');
      expect(bareAssurance.stdout).toContain('derive');

      const snapshotHelp = runBuilt(['sandbox', 'snapshot', '--help']);
      expect(snapshotHelp.status).toBe(1);
      expect(snapshotHelp.stdout).not.toMatch(/Serving from|Local server:/);
      expect(snapshotHelp.stderr).toContain('pyric snapshot');

      expect(existsSync(join(dir, '.pyric'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
