import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIREBASE_TESTED_AGAINST } from '../../src/version/compat-target.js';
import { parseArgs } from '../../src/cli/index.js';
import { PACKAGE_ROOT, runCli, runDispatch } from './run-cli.js';

const REMOVED_PROJECT_COMMANDS = [
  'login',
  'logout',
  'whoami',
  'auth:configure-provider',
  'auth:manage-domains',
  'firestore:discover',
] as const;
const REMOVED_BRIDGE_FLAGS = [
  ['--mode', 'prod'],
  ['--auto-approve', 'firestore.list_collections'],
  ['--require-confirm', 'firestore.delete_document'],
  ['--require-confirm-all'],
  ['--confirm-timeout', '5000'],
  ['--non-interactive'],
] as const;

describe('retained pyric command surface', () => {
  it('advertises every local-development workflow through the CLI entry', () => {
    const { code, stdout, stderr } = runCli(['--help']);

    expect(code).toBe(0);
    expect(stderr).toBe('');
    for (const command of ['init', 'sandbox', 'bridge', 'mcp', 'snapshot', 'verify', 'vendor']) {
      expect(stdout).toMatch(new RegExp(`^\\s+(?:pyric )?${command}\\b`, 'm'));
    }
  });

  it('does not expose production deployment commands', async () => {
    const help = await runDispatch(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).not.toMatch(/\bpyric deploy\b/);
    expect(help.stdout).not.toContain('hosting:channel:deploy');

    for (const command of ['deploy', 'hosting:channel:deploy']) {
      const removed = await runDispatch([command]);
      expect(removed.code).toBe(1);
      expect(removed.stderr).toContain(`unknown command '${command}'`);
    }
  });

  it('does not advertise production project or credential commands', async () => {
    const help = await runDispatch(['--help']);
    expect(help.code).toBe(0);

    for (const command of REMOVED_PROJECT_COMMANDS) {
      expect(help.stdout).not.toMatch(new RegExp(`^\\s+(?:pyric )?${command}\\b`, 'm'));
    }
  });

  for (const command of REMOVED_PROJECT_COMMANDS) {
    it(`rejects removed command ${command}`, async () => {
      const removed = await runDispatch([command]);
      expect(removed.code).toBe(1);
      expect(removed.stderr).toContain(`unknown command '${command}'`);
    });
  }

  for (const [flag, value] of REMOVED_BRIDGE_FLAGS) {
    it(`rejects removed bridge option ${flag}`, async () => {
      const result = await runDispatch(['bridge', flag, ...(value === undefined ? [] : [value])]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`unknown option '${flag}' for pyric bridge`);
    });
  }

});

describe('service command hierarchy', () => {
  it('advertises every service artifact operation with space-delimited names', async () => {
    const help = await runDispatch(['--help']);

    expect(help.code).toBe(0);
    for (const command of [
      'firestore rules validate',
      'firestore rules resolve',
      'firestore indexes generate',
      'storage rules resolve',
      'database rules validate',
      'database rules generate',
      'database indexes generate',
    ]) {
      expect(help.stdout).toContain(`pyric ${command}`);
    }
  });

  it('routes Firestore rules validate through the namespaced command', async () => {
    const rulesPath = join(PACKAGE_ROOT, 'test', 'e2e', 'fixture', 'firestore.rules');
    const result = await runDispatch(['firestore', 'rules', 'validate', rulesPath]);

    // The fixture's recursive wildcard allows signed-in reads and writes,
    // a high-severity finding (SEC-5), so the command exits 2.
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    const findings = JSON.parse(result.stdout) as Array<{ code: string; severity: string }>;
    expect(findings.map((finding) => [finding.code, finding.severity])).toContainEqual(['SEC-5', 'high']);
  });

  it('rejects Firestore rules that exceed compile limits in firestore rules validate (FS-CON-2)', async () => {
    const { runRulesValidate } = await import('../../src/cli/rules.js');
    const nestedGlob = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{a=**}/sub/{b=**} {
      allow read: if request.auth != null;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;
    let out = '';
    const code = await runRulesValidate(
      parseArgs(['firestore', 'rules', 'validate', 'firestore.rules']),
      {
        readFile: async () => nestedGlob as never,
        stdout: { write: (s: string) => { out += s; } },
        stderr: { write: () => {} },
      },
    );
    expect(code).toBe(2);
    const findings = JSON.parse(out) as Array<{ code: string; severity: string }>;
    expect(findings.some((f) => f.code === 'GLOB_MATCH_COUNT' && f.severity === 'critical')).toBe(true);
  });

  it('resolves 2+modules imports before validating Firestore rules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-validate-modules-'));
    try {
      writeFileSync(join(dir, 'helpers.rules'), 'export function denyAll() { return false; }\n', 'utf8');
      const rulesPath = join(dir, 'firestore.rules');
      writeFileSync(
        rulesPath,
        [
          "rules_version = '2+modules';",
          "import { denyAll } from './helpers';",
          'service cloud.firestore {',
          '  match /databases/{db}/documents {',
          '    match /items/{id} {',
          '      allow read, write: if denyAll();',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      const valid = await runDispatch(['firestore', 'rules', 'validate', rulesPath]);
      expect(valid.code).toBe(0);
      expect(valid.stderr).toBe('');

      const brokenPath = join(dir, 'broken.rules');
      writeFileSync(
        brokenPath,
        [
          "rules_version = '2+modules';",
          "import { denyAll } from './missing';",
          'service cloud.firestore {',
          '  match /databases/{db}/documents {',
          '    match /items/{id} { allow read: if denyAll(); }',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      const broken = await runDispatch(['firestore', 'rules', 'validate', brokenPath]);
      expect(broken.code).toBe(2);
      expect(broken.stderr).toContain('missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves Firestore rules modules through the namespaced command', async () => {
    const sourcePath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'firestore.modules.rules');
    const result = await runDispatch(['firestore', 'rules', 'resolve', sourcePath]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain("rules_version = '2';");
    expect(result.stdout).toContain('function isAuthenticated()');
  });

  it('resolves Storage rules modules through the namespaced command', async () => {
    const sourcePath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'storage.modules.rules');
    const result = await runDispatch(['storage', 'rules', 'resolve', sourcePath]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain("rules_version = '2';");
    expect(result.stdout).toContain('function sizeAtMost(maxBytes)');
    expect(result.stdout).toContain('service firebase.storage');
  });

  it('rejects a Firestore source passed to Storage rules resolve', async () => {
    const sourcePath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'firestore.modules.rules');
    const result = await runDispatch(['storage', 'rules', 'resolve', sourcePath]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'source declares service cloud.firestore; expected firebase.storage',
    );
  });

  it('generates Firestore indexes through the namespaced command', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'pyric-firestore-indexes-'));
    const sourcePath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'firestore-queries.ts');
    const outputPath = join(outputDir, 'firestore.indexes.json');

    try {
      const result = await runDispatch([
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

  it('skips an index for a dynamic collection id and says so', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'pyric-firestore-indexes-'));
    const sourcePath = join(outputDir, 'queries.ts');
    const outputPath = join(outputDir, 'firestore.indexes.json');
    writeFileSync(sourcePath, `
      export function listChildren(parentId: string, childCollection: string, s: string) {
        let q = query(collection(db, 'parents', parentId, childCollection));
        q = query(q, where('status', '==', s));
        q = query(q, orderBy('createdAt', 'desc'));
        return q;
      }
    `);

    try {
      const result = await runDispatch(['firestore', 'indexes', 'generate', sourcePath, '--out', outputPath]);

      expect(result.code).toBe(0);
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({ indexes: [] });
      expect(result.stderr).toContain('index for a wildcard collection id skipped: name the collection');
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('routes Database rules validate through the namespaced command', async () => {
    const rulesPath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'database.rules.json');
    const result = await runDispatch(['database', 'rules', 'validate', rulesPath]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toHaveProperty('errors');
  });

  it('routes Database rules generate through the namespaced command', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'pyric-database-rules-'));
    const configPath = join(PACKAGE_ROOT, 'test', 'cli', 'fixtures', 'database.rules.ts');
    const outputPath = join(outputDir, 'database.rules.json');

    try {
      const result = await runDispatch([
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
      it(`rejects ${command} without an alias`, async () => {
        const result = await runDispatch([command]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`unknown command '${command}'`);
      });
    }
  });
});

describe('pyric sandbox command surface', () => {
  it('rejects the removed dev spelling instead of retaining an alias', async () => {
    expect((await runDispatch(['dev'])).code).toBe(1);
  });

  it('advertises sandbox and never the removed dev or serve spellings', async () => {
    const { code, stdout } = await runDispatch(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('pyric sandbox [flags] [--] [command...]');
    expect(stdout).not.toContain('pyric dev');
    // Named inspection commands remain; bare `pyric serve` is still retired.
    expect(stdout).toContain('pyric serve diagnostics');
    expect(stdout).toContain('pyric serve sessions');
    expect(stdout).toContain('pyric serve repro capture');
    expect(stdout).toContain('pyric serve denials');
    expect(stdout).toContain('pyric serve repro replay');
    expect(stdout).not.toMatch(/pyric serve(?!(?: sessions| diagnostics| denials| repro capture| repro replay)\b)/);
  });

  it('rejects the removed serve spelling for the sandbox', async () => {
    expect((await runDispatch(['serve'])).code).toBe(1);
  });

  it('parses --session-token as a boolean flag without consuming child positionals and rejects --no-session-token', async () => {
    const parsed = parseArgs(['sandbox', '--session-token', 'node', 'app.js']);
    expect(parsed.flags.get('session-token')).toBe(true);
    expect(parsed.positional).toEqual(['node', 'app.js']);

    const help = await runDispatch(['--help']);
    expect(help.stdout).toContain('--session-token');
    expect(help.stdout).not.toContain('--no-session-token');

    const badBridge = await runDispatch(['bridge', '--no-session-token']);
    expect(badBridge.code).toBe(1);
    expect(badBridge.stderr).toContain('--no-session-token');

    const badSandbox = await runDispatch(['sandbox', '--no-session-token']);
    expect(badSandbox.code).toBe(1);
    expect(badSandbox.stderr).toContain('--no-session-token');
  });
});

const ownVersion = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

describe('pyric version output', () => {
  for (const flag of ['--version', '-v']) {
    it(`${flag} names the package and tested-against Firebase versions`, async () => {
      const { code, stdout } = await runDispatch([flag]);
      expect(code).toBe(0);
      expect(stdout).toContain(ownVersion);
      expect(stdout).toContain(FIREBASE_TESTED_AGAINST);
    });
  }

  it('--help prints @pyric/cli package version in its banner lazily', async () => {
    const { code, stdout } = await runDispatch(['--help']);
    expect(code).toBe(0);
    expect(stdout.startsWith(`pyric ${ownVersion}\n`)).toBe(true);

    const prev = globalThis.__PYRIC_EMBEDDED__;
    try {
      globalThis.__PYRIC_EMBEDDED__ = {
        version: '5.4.3-embedded',
        workerVersion: 'wv',
        sdk: async () => ({}),
        site: async () => ({}),
      };
      const embeddedHelp = await runDispatch(['--help']);
      expect(embeddedHelp.code).toBe(0);
      expect(embeddedHelp.stdout.startsWith('pyric 5.4.3-embedded\n')).toBe(true);
    } finally {
      globalThis.__PYRIC_EMBEDDED__ = prev;
    }
  });
});

describe('pyric bridge --port validation', () => {
  async function runBridgeExpectingImmediateExit(
    args: string[],
    envPort?: string,
  ): Promise<{ code: number | 'did-not-exit'; stdout: string; stderr: string }> {
    const prevPort = process.env.PYRIC_PORT;
    if (envPort === undefined) {
      delete process.env.PYRIC_PORT;
    } else {
      process.env.PYRIC_PORT = envPort;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        runDispatch(args),
        new Promise<'did-not-exit'>((resolve) => {
          timer = setTimeout(() => resolve('did-not-exit'), 1000);
        }),
      ]);
      if (raced === 'did-not-exit') {
        return { code: 'did-not-exit', stdout: '', stderr: '' };
      }
      return raced;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (prevPort === undefined) {
        delete process.env.PYRIC_PORT;
      } else {
        process.env.PYRIC_PORT = prevPort;
      }
    }
  }

  for (const [label, argv, envPort] of [
    ['negative (--port=-1)', ['bridge', '--port=-1'], undefined],
    ['negative (--port -1)', ['bridge', '--port', '-1'], undefined],
    ['negative zero (--port=-0)', ['bridge', '--port=-0'], undefined],
    ['float (--port 3.14)', ['bridge', '--port', '3.14'], undefined],
    ['above 65535 (--port 65536)', ['bridge', '--port', '65536'], undefined],
    ['NaN (--port NaN)', ['bridge', '--port', 'NaN'], undefined],
    ['non-numeric (--port abc)', ['bridge', '--port', 'abc'], undefined],
    ['empty string (--port "")', ['bridge', '--port', ''], undefined],
    ['empty equals (--port=)', ['bridge', '--port='], undefined],
    ['whitespace (--port "   ")', ['bridge', '--port', '   '], undefined],
    ['missing value (--port)', ['bridge', '--port'], undefined],
    ['missing short value (-p)', ['bridge', '-p'], undefined],
    ['repeated (--port 5174 --port 5175)', ['bridge', '--port', '5174', '--port', '5175'], undefined],
    ['whitespace PYRIC_PORT', ['bridge'], '   '],
    ['float PYRIC_PORT', ['bridge'], '3.14'],
    ['negative PYRIC_PORT', ['bridge'], '-1'],
  ] as const) {
    it(`rejects ${label} with exit 1 and invalid --port message`, async () => {
      const res = await runBridgeExpectingImmediateExit([...argv], envPort);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('pyric: invalid --port');
    });
  }
});
