/**
 * Execution-time `PATH` shim and shared `env`/shell sanitizer bounds for
 * `spawnSandboxChild` (ADR 0023):
 *   (a) `bun`/`deno` reached through bundled shell/`env` flags, subshells, `case`
 *       substitutions, dynamic wrapper options, or external scripts hit the stub.
 *   (b) `node` reached through bundled `env` flags, `env -S`, `sh -c` inline
 *       overrides, or a `package.json` `npm run` script setting `NODE_OPTIONS`
 *       still loads the sandbox and preserves user `NODE_OPTIONS` flags.
 *   (c) A `PATH` without `bun`/`bunx`/`deno` receives no `bun`/`bunx`/`deno` stub,
 *       keeping `command -v bun` honest.
 *   (d) The `0700` shim directory is removed after child exit and after spawn error.
 *   (e) Unclassifiable but harmless shell constructs (`eval`, `$(...)`, `case`) run.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutableOnPath } from '../../src/cli/launcher-path-shim.js';
import { buildChildEnv, registerModuleUrl, spawnSandboxChild } from '../../src/cli/sandbox-runner.js';
import { UNSUPPORTED_RUNTIME_CODE } from '../../src/cli/unsupported-runtime.js';

const tempDirs: string[] = [];
function makeDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runCapturingStderr(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stderr: string }> {
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const handle = spawnSandboxChild({ argv, label: argv.join(' ') }, { cwd, env, json: true });
    const code = await handle.exited;
    return { code, stderr: chunks.join('') };
  } finally {
    process.stderr.write = origWrite;
  }
}

describe('spawnSandboxChild execution-time PATH shim & sanitizer bounds', () => {
  it('(a) blocks PATH-resolved bun/deno across bundled shell/env flags, subshell/case substitutions, and opaque dynamic scripts', async () => {
    const dir = makeDir('pyric-shim-runtimes-');
    const fakeBinDir = path.join(dir, 'fake-bin');
    mkdirSync(fakeBinDir, { recursive: true });
    const leakedMarker = path.join(dir, 'leaked-runtime.txt');
    for (const rt of ['bun', 'deno']) {
      const markerBin = path.join(fakeBinDir, rt);
      writeFileSync(markerBin, `#!/bin/sh\necho ${rt} >> ${JSON.stringify(leakedMarker)}\nexit 0\n`);
      chmodSync(markerBin, 0o755);
    }

    const basePath = `${fakeBinDir}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`;
    const baseEnv = buildChildEnv(
      { ...process.env, PATH: basePath },
      { serveUrl: 'http://127.0.0.1:45999', registerUrl: registerModuleUrl() },
    );

    const vectors: string[][] = [
      ['sh', '-oc', 'errexit', 'bun x'],
      ['sh', '-co', 'errexit', 'bun x'],
      ['bash', '-Oc', 'extglob', 'bun x'],
      ['env', '-vS', 'bun x'],
      ['env', '-iS', `PATH=${basePath} bun x`],
      ['sh', '-c', 'echo $((bun x); true)'],
      ['sh', '-c', '$((bun x); true)'],
      ['sh', '-c', 'echo $(case x in x) bun x;; esac)'],
      ['sh', '-c', 'F=-c; sh $F "deno run app.ts"'],
    ];

    for (const argv of vectors) {
      const res = await runCapturingStderr(argv, dir, baseEnv);
      expect(res.stderr).toContain(UNSUPPORTED_RUNTIME_CODE);
      expect(existsSync(leakedMarker)).toBe(false);
    }
  });

  it('(b) preserves sandbox activation and merges NODE_OPTIONS across bundled env flags, sh -c overrides, and npm run scripts', async () => {
    const dir = makeDir('pyric-shim-node-');
    const wsPkg = fileURLToPath(new URL('../../../../package.json', import.meta.url));
    const outFile = path.join(dir, 'probe-out.json');
    const probeScript = path.join(dir, 'probe.mjs');
    writeFileSync(
      probeScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { createRequire } from 'node:module';",
        `const req = createRequire(${JSON.stringify(wsPkg)});`,
        "const resolved = req.resolve('firebase-admin/app');",
        `writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({`,
        "  isRealSdk: resolved.includes('/node_modules/firebase-admin/'),",
        '  sandbox: process.env.PYRIC_SANDBOX ?? null,',
        '  token: process.env.PYRIC_SESSION_TOKEN ?? null,',
        '  workerInit: process.env.PYRIC_WORKER_INIT ?? null,',
        '  nodeOptions: process.env.NODE_OPTIONS ?? "",',
        '  active: Boolean(globalThis[Symbol.for("pyric.register.active")]),',
        '}));',
        'process.exit(0);',
      ].join('\n'),
    );

    const workerInitPayload = {
      transport: 'hosted' as const,
      hostOrigin: "http://127.0.0.1:45999/o'hare",
    };
    const nodeBin = findExecutableOnPath('node', process.env.PATH) ?? 'node';
    const registerUrl = registerModuleUrl();
    const baseEnv = buildChildEnv(
      { ...process.env },
      {
        serveUrl: 'http://127.0.0.1:45999',
        registerUrl,
        sessionToken: "sess'tok",
        workerInit: workerInitPayload as never,
      },
    );

    const directMatrix: string[][] = [
      ['env', '-iv', nodeBin, probeScript],
      ['env', '-iu', 'UNUSED', nodeBin, probeScript],
      ['env', '-vu', 'PYRIC_SANDBOX', '-vu', 'NODE_OPTIONS', nodeBin, probeScript],
      ['env', '-S', `-u PYRIC_SANDBOX -u NODE_OPTIONS ${JSON.stringify(nodeBin)} ${JSON.stringify(probeScript)}`],
      ['env', '-vS', `PYRIC_SANDBOX= NODE_OPTIONS= ${JSON.stringify(nodeBin)} ${JSON.stringify(probeScript)}`],
      ['sh', '-c', `PYRIC_SANDBOX= NODE_OPTIONS= PYRIC_SESSION_TOKEN=forged ${JSON.stringify(nodeBin)} ${JSON.stringify(probeScript)}`],
    ];

    for (const argv of directMatrix) {
      rmSync(outFile, { force: true });
      const res = await runCapturingStderr(argv, dir, baseEnv);
      expect(res.code).toBe(0);
      const parsed = JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, unknown>;
      expect(parsed.isRealSdk).toBe(false);
      expect(parsed.sandbox).toBe('remote:http://127.0.0.1:45999');
      expect(parsed.token).toBe("sess'tok");
      expect(JSON.parse(parsed.workerInit as string)).toEqual(workerInitPayload);
      expect(parsed.active).toBe(true);
    }

    // Real `npm run dev` with package.json script that overrides NODE_OPTIONS and unsets PYRIC_SANDBOX
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'npm-script-app',
        private: true,
        scripts: {
          dev: `PYRIC_SANDBOX= NODE_OPTIONS=--max-old-space-size=256 node ${JSON.stringify(probeScript)}`,
        },
      }),
    );
    rmSync(outFile, { force: true });
    const npmRes = await runCapturingStderr(['npm', 'run', '--silent', 'dev'], dir, baseEnv);
    expect(npmRes.code).toBe(0);
    const npmParsed = JSON.parse(readFileSync(outFile, 'utf8')) as {
      isRealSdk: boolean;
      sandbox: string;
      token: string;
      workerInit: string;
      nodeOptions: string;
      active: boolean;
    };
    expect(npmParsed.isRealSdk).toBe(false);
    expect(npmParsed.sandbox).toBe('remote:http://127.0.0.1:45999');
    expect(npmParsed.token).toBe("sess'tok");
    expect(JSON.parse(npmParsed.workerInit)).toEqual(workerInitPayload);
    expect(npmParsed.nodeOptions).toContain('--max-old-space-size=256');
    expect(npmParsed.nodeOptions).toContain(`--import ${registerUrl}`);
    expect(npmParsed.active).toBe(true);
  }, 30_000);

  it('(c, d, e) creates no bun/deno stub when absent from PATH, enforces 0700 & cleanup on exit/error, and runs harmless dynamic shell commands', async () => {
    const dir = makeDir('pyric-shim-minimal-');
    const minimalBin = path.join(dir, 'minimal-bin');
    mkdirSync(minimalBin, { recursive: true });
    const shReal = findExecutableOnPath('sh', process.env.PATH) ?? '/bin/sh';
    const nodeReal = findExecutableOnPath('node', process.env.PATH);
    expect(nodeReal).not.toBeNull();
    symlinkSync(shReal, path.join(minimalBin, 'sh'));
    symlinkSync(nodeReal!, path.join(minimalBin, 'node'));

    const outFile = path.join(dir, 'minimal-out.json');
    const inspectJs = path.join(dir, 'inspect.mjs');
    writeFileSync(
      inspectJs,
      [
        "import { readdirSync, statSync, writeFileSync } from 'node:fs';",
        'const shimDir = (process.env.PATH ?? "").split(":")[0];',
        `writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({`,
        '  shimDir,',
        '  entries: readdirSync(shimDir).sort(),',
        '  mode: statSync(shimDir).mode & 0o777,',
        '  port: process.env.PORT ?? null,',
        '  active: Boolean(globalThis[Symbol.for("pyric.register.active")]),',
        '}));',
        'process.exit(0);',
      ].join('\n'),
    );

    const baseEnv = buildChildEnv(
      { ...process.env, PATH: minimalBin },
      { serveUrl: 'http://127.0.0.1:45999', registerUrl: registerModuleUrl() },
    );

    // (c) `command -v bun` stays empty when bun is not on pre-shim PATH, and (e) harmless eval/$(...)/case run cleanly
    const script = `if command -v bun >/dev/null 2>&1; then exit 42; fi; PORT=$(sh -c 'printf 4123'); export PORT; eval 'case x in x) node ${JSON.stringify(inspectJs)};; esac'`;
    const runRes = await runCapturingStderr(['sh', '-c', script], dir, baseEnv);
    expect(runRes.code).toBe(0);

    const inspected = JSON.parse(readFileSync(outFile, 'utf8')) as {
      shimDir: string;
      entries: string[];
      mode: number;
      port: string;
      active: boolean;
    };
    expect(inspected.entries).toEqual(['node']);
    expect(inspected.mode).toBe(0o700);
    expect(inspected.port).toBe('4123');
    expect(inspected.active).toBe(true);
    // (d) Shim dir removed after child exit
    expect(existsSync(inspected.shimDir)).toBe(false);

    // (d) Shim dir also removed after spawn error (ENOENT), with zero leaked `pyric-launch-shim-*` dirs
    const beforeShims = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('pyric-launch-shim-')));
    const errRes = await runCapturingStderr([path.join(dir, 'missing-binary-xyz')], dir, baseEnv);
    expect(errRes.code).toBe(1);
    const afterShims = readdirSync(tmpdir()).filter((n) => n.startsWith('pyric-launch-shim-') && !beforeShims.has(n));
    expect(afterShims).toEqual([]);
  });
});
