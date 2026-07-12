/**
 * CLI argument-parsing + dispatch tests.
 *
 * Each subcommand handler accepts an injectable `deps` arg so the
 * tests assert dispatch happens with the right shape without going
 * near the real Google APIs, real disk reads, or real service-account
 * loading. The injection seam is the contract — these tests pin it.
 *
 * Conventions:
 *   - `bufferIo()` returns `{ stdout, stderr, getOut, getErr }`
 *     suitable for handing to any subcommand's `deps`.
 *   - Helper `makeScope()` returns a structurally-valid ProjectScope
 *     without hitting the JWT flow.
 *   - Argv is parsed via the real `parseArgs` to exercise the CLI's
 *     flag handling end-to-end (no shortcuts).
 */

import { describe, it, expect, mock } from 'bun:test';

import { parseArgs } from './parse-args.js';
import { runRulesLint, runRulesValidate, runRulesSimulate } from './rules.js';
import {
  runDatabaseRulesLint,
  runDatabaseRulesValidate,
  runDatabaseRulesSimulate,
  runDatabaseRulesGenerate,
} from './database-rules.js';
import { runInit } from './init.js';

// ── Test helpers ──────────────────────────────────────────────────────

function bufferIo() {
  let outBuf = '';
  let errBuf = '';
  return {
    stdout: { write(s: string): void { outBuf += s; } },
    stderr: { write(s: string): void { errBuf += s; } },
    getOut: () => outBuf,
    getErr: () => errBuf,
  };
}

// ── parseArgs ─────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('captures subcommand + positionals + long flags', () => {
    const p = parseArgs(['firestore', 'rules', '--project', 'my-proj']);
    expect(p.subcommand).toBe('firestore');
    expect(p.positional).toEqual(['rules']);
    expect(p.flags.get('project')).toBe('my-proj');
  });

  it('parses --flag=value syntax', () => {
    const p = parseArgs(['simulate', '--stdin=true']);
    expect(p.flags.get('stdin')).toBe('true');
  });

  it('treats a flag without a value as boolean true', () => {
    const p = parseArgs(['simulate', '--stdin']);
    expect(p.flags.get('stdin')).toBe(true);
  });

  it('preserves repeated long flags in order', () => {
    const p = parseArgs([
      'verify',
      '--service',
      'firestore',
      '--service',
      'rtdb',
      '--rules=firestore=firestore.rules',
      '--rules',
      'database=database.rules.json',
    ]);
    expect(p.flags.get('service')).toEqual(['firestore', 'rtdb']);
    expect(p.flags.get('rules')).toEqual([
      'firestore=firestore.rules',
      'database=database.rules.json',
    ]);
  });
});

// ── Firestore rules ──────────────────────────────────────────────────

describe('runRulesLint', () => {
  it('errors out when no path given', async () => {
    const io = bufferIo();
    const code = await runRulesLint(parseArgs(['lint']), { ...io });
    expect(code).toBe(1);
    expect(io.getErr()).toContain('missing rules-file path');
  });

  it('passes the source to the linter and prints JSON', async () => {
    const io = bufferIo();
    const lintFn = mock(() => ({ warnings: [], metrics: { sourceSize: 5 } as never }));
    const code = await runRulesLint(parseArgs(['lint', 'firestore.rules']), {
      ...io,
      cwd: '/tmp',
      readFile: (async () => 'source') as never,
      lintFirestoreRules: lintFn as never,
    });
    expect(code).toBe(0);
    expect(lintFn).toHaveBeenCalledTimes(1);
    expect(lintFn).toHaveBeenCalledWith('source');
    const out = JSON.parse(io.getOut()) as { warnings: unknown[] };
    expect(out.warnings).toEqual([]);
  });
});

describe('runRulesValidate', () => {
  it('errors out when no path given', async () => {
    const io = bufferIo();
    const code = await runRulesValidate(parseArgs(['validate']), { ...io });
    expect(code).toBe(1);
  });

  it('reports parse failure with exit 2 on invalid rules', async () => {
    const io = bufferIo();
    const code = await runRulesValidate(parseArgs(['validate', 'bad.rules']), {
      ...io,
      cwd: '/tmp',
      readFile: (async () => 'not valid rules at all') as never,
    });
    expect(code).toBe(2);
    expect(io.getErr()).toContain('failed to parse');
  });
});

describe('runRulesSimulate', () => {
  it('runs a sample test against firebase.json rules path', async () => {
    const io = bufferIo();
    const simulateFn = mock(() => ({
      success: true,
      data: { results: [], passed: 0, failed: 0 },
    } as never));
    const code = await runRulesSimulate(parseArgs(['simulate']), {
      ...io,
      cwd: '/tmp',
      readFirebaseJson: async () => ({ firestore: { rules: 'firestore.rules' } }),
      readFile: (async () => 'rules source') as never,
      simulate: simulateFn as never,
    });
    expect(code).toBe(0);
    expect(simulateFn).toHaveBeenCalledTimes(1);
    const callArgs = (simulateFn.mock.calls[0] ?? []) as [string, unknown[]];
    expect(callArgs[0]).toBe('rules source');
    expect(callArgs[1]).toHaveLength(1);
  });

  it('reads request from stdin when --stdin is set', async () => {
    const io = bufferIo();
    const simulateFn = mock(() => ({ success: true, data: { results: [], passed: 0, failed: 0 } } as never));
    const code = await runRulesSimulate(parseArgs(['simulate', '--stdin']), {
      ...io,
      cwd: '/tmp',
      readStdin: async () =>
        JSON.stringify({
          source: 'inline rules',
          testCases: [
            { description: 't', expectation: 'ALLOW', method: 'get', path: 'x/1', auth: null },
            { description: 't2', expectation: 'DENY', method: 'get', path: 'x/2', auth: null },
          ],
        }),
      simulate: simulateFn as never,
    });
    expect(code).toBe(0);
    const callArgs = (simulateFn.mock.calls[0] ?? []) as [string, unknown[]];
    expect(callArgs[0]).toBe('inline rules');
    expect(callArgs[1]).toHaveLength(2);
  });
});

// ── database rules ───────────────────────────────────────────────────

describe('runDatabaseRulesLint', () => {
  it('errors out when no path given', async () => {
    const io = bufferIo();
    const code = await runDatabaseRulesLint(parseArgs(['lint']), { ...io });
    expect(code).toBe(1);
    expect(io.getErr()).toContain('missing rules-file path');
  });

  it('prints RTDB expression lints as JSON', async () => {
    const io = bufferIo();
    const code = await runDatabaseRulesLint(parseArgs(['lint', 'database.rules.json']), {
      ...io,
      cwd: '/tmp',
      readFile: (async () => '{"rules":{".read":true,".write":false}}') as never,
    });
    expect(code).toBe(0);
    const out = JSON.parse(io.getOut()) as { warnings: Array<{ code: string }> };
    expect(out.warnings.map((finding) => finding.code).sort()).toEqual([
      'HARDCODED_FALSE',
      'HARDCODED_TRUE',
    ]);
  });
});

describe('runDatabaseRulesValidate', () => {
  it('reports RTDB expression parse errors', async () => {
    const io = bufferIo();
    const code = await runDatabaseRulesValidate(parseArgs(['validate', 'database.rules.json']), {
      ...io,
      cwd: '/tmp',
      readFile: (async () => '{"rules":{".read":"auth.uid =="}}') as never,
    });
    expect(code).toBe(0);
    const out = JSON.parse(io.getOut()) as { errors: Array<{ code: string }> };
    expect(out.errors.some((finding) => finding.code === 'PARSE_ERROR')).toBe(true);
  });
});

describe('runDatabaseRulesSimulate', () => {
  it('simulates inline RTDB rules from stdin', async () => {
    const io = bufferIo();
    const code = await runDatabaseRulesSimulate(parseArgs(['simulate', '--stdin']), {
      ...io,
      readStdin: async () =>
        JSON.stringify({
          rulesJson: { rules: { '.read': true } },
          operation: 'read',
          path: '/sample',
          auth: null,
          mockData: {},
        }),
    });
    expect(code).toBe(0);
    const result = JSON.parse(io.getOut()) as { success: boolean; data: { allowed: boolean } };
    expect(result.success).toBe(true);
    expect(result.data.allowed).toBe(true);
  });
});

describe('runDatabaseRulesGenerate', () => {
  it('loads the constraints module, compiles via toJSON(), and writes the file', async () => {
    const { defineRtdbRules, allow, deny } = await import('pyric/rules');
    const doc = defineRtdbRules({
      paths: { '/': { read: allow(), write: deny() } },
    });

    const io = bufferIo();
    const writes: Array<{ path: unknown; contents: unknown }> = [];
    const code = await runDatabaseRulesGenerate(parseArgs(['generate']), {
      ...io,
      cwd: '/project',
      loadRulesDocument: (async () => ({ ok: true, document: doc })) as never,
      readFirebaseJson: (async () => ({ database: { rules: 'database.rules.json' } })) as never,
      mkdir: (async () => undefined) as never,
      writeFile: (async (path: unknown, contents: unknown) => {
        writes.push({ path, contents });
      }) as never,
    });

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/project/database.rules.json');
    expect(writes[0]?.contents).toBe(`${JSON.stringify(doc.toJSON(), null, 2)}\n`);
    expect(io.getOut()).toContain('/project/database.rules.json');
  });

  it('reports a clear error when no constraints module is found', async () => {
    const io = bufferIo();
    const code = await runDatabaseRulesGenerate(parseArgs(['generate']), {
      ...io,
      cwd: '/project',
      loadRulesDocument: (async () => ({
        ok: false,
        message: 'no constraints module found',
      })) as never,
    });

    expect(code).toBe(1);
    expect(io.getErr()).toContain('no constraints module found');
  });

  it('honors --config and --out flags', async () => {
    const { defineRtdbRules, allow, deny } = await import('pyric/rules');
    const doc = defineRtdbRules({ paths: { '/': { read: deny(), write: deny() } } });

    const io = bufferIo();
    let loadedPath: string | undefined;
    const writes: Array<{ path: unknown }> = [];
    const code = await runDatabaseRulesGenerate(
      parseArgs(['generate', '--config', 'rtdb.rules.ts', '--out', 'out/rules.json']),
      {
        ...io,
        cwd: '/project',
        loadRulesDocument: (async (configPath: string) => {
          loadedPath = configPath;
          return { ok: true, document: doc };
        }) as never,
        mkdir: (async () => undefined) as never,
        writeFile: (async (path: unknown) => {
          writes.push({ path });
        }) as never,
      },
    );

    expect(code).toBe(0);
    expect(loadedPath).toBe('rtdb.rules.ts');
    expect(writes[0]?.path).toBe('/project/out/rules.json');
  });
});

// ── auth ──────────────────────────────────────────────────────────────

// ── init ─────────────────────────────────────────────────────────────

describe('runInit', () => {
  it('writes the full local-first Pyric scaffold when none exist', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    const mkdirFn = mock(async () => undefined);
    const code = await runInit(parseArgs(['init', '--template=node']), {
      ...io,
      cwd: '/tmp/scaffold',
      writeFile: writeFn as never,
      mkdir: mkdirFn as never,
      exists: async () => false,
    });
    expect(code).toBe(0);
    // 9 files: package.json, src/app.ts, .env.example, src/seed.ts,
    // firestore.rules, firebase.json, firestore.indexes.json, README.md,
    // .gitignore
    expect(writeFn).toHaveBeenCalledTimes(9);
    const paths = writeFn.mock.calls.map((c) => c[0]);
    expect(paths).toContain('/tmp/scaffold/package.json');
    expect(paths).toContain('/tmp/scaffold/src/app.ts');
    expect(paths).toContain('/tmp/scaffold/src/seed.ts');
    expect(paths).toContain('/tmp/scaffold/firestore.rules');
    expect(paths).toContain('/tmp/scaffold/firebase.json');
    expect(paths).toContain('/tmp/scaffold/firestore.indexes.json');
    expect(paths).toContain('/tmp/scaffold/README.md');
    expect(paths).toContain('/tmp/scaffold/.gitignore');
    // src/ dir is mkdir'd before writing into it
    expect(mkdirFn).toHaveBeenCalledWith('/tmp/scaffold/src', { recursive: true });
    // package.json uses the directory basename as the project name
    const pkgCall = writeFn.mock.calls.find((c) => c[0] === '/tmp/scaffold/package.json');
    expect(pkgCall?.[1]).toContain('"name": "scaffold"');
    // App template: PYRIC_TARGET env picks sandbox vs firebase backend
    const appCall = writeFn.mock.calls.find((c) => c[0] === '/tmp/scaffold/src/app.ts');
    expect(appCall?.[1]).toContain("from 'pyric/sandbox'");
    expect(appCall?.[1]).toContain('PYRIC_TARGET');
    expect(appCall?.[1]).toContain('initializeApp({ sandbox: initializeSandbox() })');
  });

  it('honors --name override for the package name', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    const code = await runInit(parseArgs(['init', '--name=my-app']), {
      ...io,
      cwd: '/tmp/scaffold-named',
      writeFile: writeFn as never,
      mkdir: mock(async () => undefined) as never,
      exists: async () => false,
    });
    expect(code).toBe(0);
    const pkgCall = writeFn.mock.calls.find((c) => c[0] === '/tmp/scaffold-named/package.json');
    expect(pkgCall?.[1]).toContain('"name": "my-app"');
  });

  it('skips files that already exist (non-package.json)', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    const code = await runInit(parseArgs(['init', '--template=node']), {
      ...io,
      cwd: '/tmp/scaffold2',
      writeFile: writeFn as never,
      mkdir: mock(async () => undefined) as never,
      exists: async (p) => p.endsWith('firebase.json'),
    });
    expect(code).toBe(0);
    // 1 package.json + 7 non-package.json files written, firebase.json skipped
    expect(writeFn).toHaveBeenCalledTimes(8);
    expect(io.getOut()).toContain('skipped firebase.json');
  });

  it('merges into an existing package.json — adds missing scripts + deps, never overwrites', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    const existingPkg = JSON.stringify(
      {
        name: 'my-existing-app',
        type: 'module',
        scripts: { test: 'jest', start: 'node existing.js' },
        dependencies: { express: '^4.0.0' },
      },
      null,
      2,
    );
    const code = await runInit(parseArgs(['init', '--template=node']), {
      ...io,
      cwd: '/tmp/merge-test',
      writeFile: writeFn as never,
      readFile: mock(async () => existingPkg) as never,
      mkdir: mock(async () => undefined) as never,
      // Only package.json exists; all others don't.
      exists: async (p) => p.endsWith('package.json'),
    });
    expect(code).toBe(0);
    const pkgCall = writeFn.mock.calls.find((c) => c[0] === '/tmp/merge-test/package.json');
    expect(pkgCall).toBeDefined();
    const written = JSON.parse(pkgCall![1] as string);

    // User's existing values preserved.
    expect(written.name).toBe('my-existing-app');
    expect(written.scripts.test).toBe('jest');
    expect(written.scripts.start).toBe('node existing.js'); // NOT overwritten
    expect(written.dependencies.express).toBe('^4.0.0');

    // Missing pyric scripts + deps added.
    expect(written.scripts.bridge).toBe('pyric bridge');
    expect(written.scripts.dev).toBe('bun --watch src/app.ts');
    expect(written.scripts['deploy:rules']).toBe('firebase deploy --only firestore:rules');
    expect(written.dependencies.pyric).toBe('*');
    expect(written.dependencies['@pyric/cli']).toBe('*');
    expect(written.devDependencies['firebase-tools']).toBe('*');
    expect(written.devDependencies.typescript).toBe('^5.7.0');

    // User-facing report mentions the conflict on `start`.
    const out = io.getOut();
    expect(out).toContain('merged package.json');
    expect(out).toContain('scripts.start');
    expect(out).toContain('node existing.js');
  });

  it('reports unchanged when existing package.json already has everything', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    // A package.json that already contains every required field.
    const completePkg = JSON.stringify(
      {
        name: 'complete',
        type: 'module',
        private: true,
        scripts: {
          start: 'bun src/app.ts',
          dev: 'bun --watch src/app.ts',
          bridge: 'pyric bridge',
          'deploy:rules': 'firebase deploy --only firestore:rules',
        },
        dependencies: { pyric: '*', '@pyric/cli': '*' },
        devDependencies: {
          '@types/bun': 'latest',
          'firebase-tools': '*',
          typescript: '^5.7.0',
        },
      },
      null,
      2,
    );
    const code = await runInit(parseArgs(['init', '--template=node']), {
      ...io,
      cwd: '/tmp/complete',
      writeFile: writeFn as never,
      readFile: mock(async () => completePkg) as never,
      mkdir: mock(async () => undefined) as never,
      exists: async (p) => p.endsWith('package.json'),
    });
    expect(code).toBe(0);
    // package.json should NOT have been rewritten — 6 other files written.
    const pkgCall = writeFn.mock.calls.find((c) => c[0] === '/tmp/complete/package.json');
    expect(pkgCall).toBeUndefined();
    expect(io.getOut()).toContain('skipped package.json'); // unchanged merge
  });
});

describe('scanForInlinedFirebase', () => {
  it('flags a bundled chunk that inlines real-SDK endpoint hosts', async () => {
    const { scanForInlinedFirebase } = await import('./serve.js');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'pyric-inline-scan-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'assets', 'index-abc.js'),
      'fetch("https://identitytoolkit.googleapis.com/v1/projects?key="+k)',
    );
    const hits = scanForInlinedFirebase(dir);
    expect(hits).toEqual(['assets/index-abc.js']);
  });

  it('stays clean for an unbundled app importing firebase by bare specifier', async () => {
    const { scanForInlinedFirebase } = await import('./serve.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'pyric-inline-clean-'));
    writeFileSync(
      join(dir, 'main.js'),
      "import { getAuth } from 'firebase/auth'; import { getFirestore } from 'firebase/firestore';",
    );
    expect(scanForInlinedFirebase(dir)).toEqual([]);
  });
});
