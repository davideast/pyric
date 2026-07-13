import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIREBASE_TESTED_AGAINST } from '../../src/version/compat-target.js';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');

function runCli(args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [CLI_ENTRY, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    input,
    timeout: 30_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('retained pyric command surface', () => {
  it('advertises every local-development workflow through the CLI entry', () => {
    const { code, stdout, stderr } = runCli(['--help']);

    expect(code).toBe(0);
    expect(stderr).toBe('');
    for (const command of ['init', 'dev', 'bridge', 'mcp', 'snapshot', 'verify', 'vendor']) {
      expect(stdout).toMatch(new RegExp(`^\\s+(?:pyric )?${command}\\b`, 'm'));
    }
  });

  it('does not expose production deployment commands', () => {
    const help = runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).not.toMatch(/\bpyric deploy\b/);
    expect(help.stdout).not.toContain('hosting:channel:deploy');

    for (const command of ['deploy', 'hosting:channel:deploy']) {
      const removed = runCli([command]);
      expect(removed.code).toBe(1);
      expect(removed.stderr).toContain(`unknown command '${command}'`);
    }
  });

  it('does not expose production project or credential commands', () => {
    const help = runCli(['--help']);
    expect(help.code).toBe(0);

    for (const command of [
      'login',
      'logout',
      'whoami',
      'auth:configure-provider',
      'auth:manage-domains',
      'firestore:discover',
    ]) {
      expect(help.stdout).not.toMatch(new RegExp(`^\\s+(?:pyric )?${command}\\b`, 'm'));
      const removed = runCli([command]);
      expect(removed.code).toBe(1);
      expect(removed.stderr).toContain(`unknown command '${command}'`);
    }
  });

  it('rejects the removed production bridge controls instead of ignoring them', () => {
    for (const [flag, value] of [
      ['--mode', 'prod'],
      ['--auto-approve', 'firestore.list_collections'],
      ['--require-confirm', 'firestore.delete_document'],
      ['--require-confirm-all'],
      ['--confirm-timeout', '5000'],
      ['--non-interactive'],
    ] as const) {
      const result = runCli(['bridge', flag, ...(value === undefined ? [] : [value])]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`unknown option '${flag}' for pyric bridge`);
    }
  });

  it('does not publish a programmatic deployment entry point', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.exports)).not.toContain('./deploy');
  });
});

describe('service command hierarchy', () => {
  it('advertises every service artifact operation with space-delimited names', () => {
    const help = runCli(['--help']);

    expect(help.code).toBe(0);
    for (const command of [
      'firestore rules lint',
      'firestore rules validate',
      'firestore rules simulate',
      'firestore rules resolve',
      'firestore indexes generate',
      'storage rules lint',
      'storage rules simulate',
      'database rules lint',
      'database rules validate',
      'database rules simulate',
      'database rules generate',
    ]) {
      expect(help.stdout).toContain(`pyric ${command}`);
    }
  });

  it('routes Firestore rules lint through the namespaced command', () => {
    const rulesPath = join(PACKAGE_ROOT, 'test', 'e2e', 'fixture', 'firestore.rules');
    const result = runCli(['firestore', 'rules', 'lint', rulesPath]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toHaveProperty('warnings');
  });

  it('routes Firestore rules validate through the namespaced command', () => {
    const rulesPath = join(PACKAGE_ROOT, 'test', 'e2e', 'fixture', 'firestore.rules');
    const result = runCli(['firestore', 'rules', 'validate', rulesPath]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toBeArray();
  });

  it('routes Firestore rules simulate through the namespaced command', () => {
    const result = runCli(
      ['firestore', 'rules', 'simulate', '--stdin'],
      JSON.stringify({
        source: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }`,
        testCases: [
          {
            description: 'anonymous read stays denied',
            expectation: 'DENY',
            method: 'get',
            path: 'notes/one',
            auth: null,
          },
        ],
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toHaveProperty('success', true);
  });

  it('resolves Firestore rules modules through the namespaced command', () => {
    const sourcePath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'firestore.modules.rules');
    const result = runCli(['firestore', 'rules', 'resolve', sourcePath]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain("rules_version = '2';");
    expect(result.stdout).toContain('function isAuthenticated()');
  });

  it('generates Firestore indexes through the namespaced command', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'pyric-firestore-indexes-'));
    const sourcePath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'firestore-queries.ts');
    const outputPath = join(outputDir, 'firestore.indexes.json');

    try {
      const result = runCli([
        'firestore',
        'indexes',
        'generate',
        sourcePath,
        '--out',
        outputPath,
      ]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toHaveProperty('indexes');
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('routes Storage rules lint through the namespaced command', () => {
    const rulesPath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'storage.rules');
    const result = runCli(['storage', 'rules', 'lint', rulesPath]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toHaveProperty('warnings');
  });

  it('routes Storage rules simulate through the namespaced command', () => {
    const rulesPath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'storage.rules');
    const result = runCli(
      ['storage', 'rules', 'simulate', '--stdin'],
      JSON.stringify({
        source: readFileSync(rulesPath, 'utf8'),
        request: {
          auth: null,
          method: 'get',
          path: 'b/pyric-default/o/notes/one.txt',
        },
        resource: { size: 12 },
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toHaveProperty('data.allowed', false);
  });

  it('routes Database rules lint through the namespaced command', () => {
    const rulesPath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'database.rules.json');
    const result = runCli(['database', 'rules', 'lint', rulesPath]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toHaveProperty('warnings');
  });

  it('routes Database rules validate through the namespaced command', () => {
    const rulesPath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'database.rules.json');
    const result = runCli(['database', 'rules', 'validate', rulesPath]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toHaveProperty('errors');
  });

  it('routes Database rules simulate through the namespaced command', () => {
    const result = runCli(
      ['database', 'rules', 'simulate', '--stdin'],
      JSON.stringify({
        rulesJson: { rules: { '.read': true } },
        operation: 'read',
        path: '/notes/one',
        auth: null,
        mockData: {},
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toHaveProperty('data.allowed', true);
  });

  it('routes Database rules generate through the namespaced command', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'pyric-database-rules-'));
    const configPath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'database.rules.ts');
    const outputPath = join(outputDir, 'database.rules.json');

    try {
      const result = runCli([
        'database',
        'rules',
        'generate',
        '--config',
        configPath,
        '--out',
        outputPath,
      ]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toHaveProperty('rules');
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  describe('retired colon-delimited spellings', () => {
    for (const command of [
      'rules:lint',
      'rules:validate',
      'rules:simulate',
      'database:rules:lint',
      'database:rules:validate',
      'database:rules:simulate',
      'database:rules:generate',
    ]) {
      it(`rejects ${command} without an alias`, () => {
        const result = runCli([command]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`unknown command '${command}'`);
      });
    }
  });
});

describe('pyric dev command surface', () => {
  it('rejects the removed serve spelling instead of retaining an alias', () => {
    expect(runCli(['serve']).code).toBe(1);
  });

  it('advertises dev and never serve', () => {
    const { code, stdout } = runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('pyric dev [flags]');
    expect(stdout).not.toContain('pyric serve');
  });
});

const ownVersion = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

describe('pyric version output', () => {
  for (const flag of ['--version', '-v']) {
    it(`${flag} names the package and tested-against Firebase versions`, () => {
      const { code, stdout } = runCli([flag]);
      expect(code).toBe(0);
      expect(stdout).toContain(ownVersion);
      expect(stdout).toContain(FIREBASE_TESTED_AGAINST);
    });
  }
});
