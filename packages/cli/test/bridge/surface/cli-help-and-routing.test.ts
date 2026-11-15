/**
 * Standing check for CLI help, bare tool listing, unknown-method hints, and
 * safe `pyric sandbox` launcher disambiguation.
 *
 * Enumerates every route in `SERVICE_COMMANDS`, every bare tool in `TOOLS`,
 * and every top-level CLI command so a newly added command or method record
 * cannot ship without focused `--help` or silently launch a server.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { METHODS, TOOLS } from '../../../src/bridge/surface/methods/registry.js';
import { dispatch, parseArgs } from '../../../src/cli/index.js';
import { SERVICE_COMMANDS } from '../../../src/cli/service-commands.generated.js';

interface DispatchCapture {
  code: number;
  stdout: string;
  stderr: string;
}

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

async function runInTempDir(args: string[]): Promise<{ result: DispatchCapture; createdPyricDir: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-help-route-'));
  const priorCwd = process.cwd();
  let stdout = '';
  let stderr = '';
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.chdir(dir);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === 'string') {
      stdout += chunk;
    } else {
      stdout += Buffer.from(chunk).toString();
    }
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === 'string') {
      stderr += chunk;
    } else {
      stderr += Buffer.from(chunk).toString();
    }
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await dispatch(parseArgs(args));
    return {
      result: { code, stdout, stderr },
      createdPyricDir: existsSync(join(dir, '.pyric')),
    };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
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
        const method = methodByKey.get(`${route[0]}.${route[1]}`);
        if (method !== undefined) {
          const { result } = await runInTempDir([...route, '--help']);
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
      expect(createdPyricDir).toBe(false);
      expect(result.stdout).not.toMatch(/Serving from|Local server:/);
      expect(result.stderr).not.toMatch(/Serving from|Local server:/);
    }

    const refusals: Array<{ argv: string[]; hint: string }> = [
      { argv: ['sandbox', 'snapshot'], hint: 'pyric snapshot' },
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
  });

  it('preserves child command parsing for explicit -- and multi-word launcher invocations', () => {
    const explicit = parseArgs(['sandbox', '--', 'npm', 'run', 'dev', '-h']);
    expect(explicit.flags.has('h')).toBe(false);
    expect(explicit.passthrough).toEqual(['npm', 'run', 'dev', '-h']);

    const multiWord = parseArgs(['sandbox', 'npm', 'run', 'dev', '-h']);
    expect(multiWord.flags.has('h')).toBe(false);
    expect(multiWord.positional).toEqual(['npm', 'run', 'dev', '-h']);

    const singleWithHelp = parseArgs(['sandbox', 'snapshot', '--help']);
    expect(singleWithHelp.flags.get('help')).toBe(true);
    expect(singleWithHelp.positional).toEqual(['snapshot']);

    const explicitSingleWithHelp = parseArgs(['sandbox', '--', 'snapshot', '--help']);
    expect(explicitSingleWithHelp.flags.has('help')).toBe(false);
    expect(explicitSingleWithHelp.passthrough).toEqual(['snapshot', '--help']);
  });
});
