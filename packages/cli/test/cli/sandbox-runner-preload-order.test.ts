/**
 * Preload ordering in `buildChildEnv` and `spawnSandboxChild` (#1588, #1619):
 * `@pyric/cli/register` runs ahead of user `--require` and `--import` preloads
 * in `NODE_OPTIONS` and ahead of CLI `node --require` flags.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChildEnv, registerModuleUrl, spawnSandboxChild } from '../../src/cli/sandbox-runner.js';
import { hasPreloadBeforeRegister } from '../../src/register/child-process-guard.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');

let fixtureDir = '';

beforeAll(() => {
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-runner-preload-order-')));
  const nm = join(fixtureDir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });
  symlinkSync(cliRoot, join(nm, '@pyric/cli'));
  symlinkSync(join(repoRoot, 'packages/pyric'), join(nm, 'pyric'));
  symlinkSync(join(repoRoot, 'packages/pyric-admin'), join(nm, 'pyric-admin'));
  if (existsSync(join(repoRoot, 'node_modules/firebase'))) {
    symlinkSync(join(repoRoot, 'node_modules/firebase'), join(nm, 'firebase'));
  }
  if (existsSync(join(repoRoot, 'node_modules/firebase-admin'))) {
    symlinkSync(join(repoRoot, 'node_modules/firebase-admin'), join(nm, 'firebase-admin'));
  }
  writeFileSync(
    join(fixtureDir, 'package.json'),
    JSON.stringify({ name: 'runner-preload-order-fixture', private: true, type: 'module' }),
  );
  writeFileSync(
    join(fixtureDir, 'pre.cjs'),
    [
      '"use strict";',
      'const adminApp = require("firebase-admin/app");',
      'globalThis.__PRE_CJS_SWAPPED__ = adminApp.ADMIN_APP_TARGET === Symbol.for("pyric.admin.app.target");',
      'globalThis.__PRE_CJS_ACTIVE__ = globalThis[Symbol.for("pyric.register.active")] === true;',
    ].join('\n'),
  );
  writeFileSync(
    join(fixtureDir, 'pre.mjs'),
    [
      'const adminApp = await import("firebase-admin/app");',
      'globalThis.__PRE_MJS_SWAPPED__ = adminApp.ADMIN_APP_TARGET === Symbol.for("pyric.admin.app.target");',
      'globalThis.__PRE_MJS_ACTIVE__ = globalThis[Symbol.for("pyric.register.active")] === true;',
    ].join('\n'),
  );
  writeFileSync(
    join(fixtureDir, 'main.mjs'),
    [
      'const adminApp = await import("firebase-admin/app");',
      'console.log("PRELOAD_ORDER_OUT " + JSON.stringify({',
      '  mainSwapped: adminApp.ADMIN_APP_TARGET === Symbol.for("pyric.admin.app.target"),',
      '  preCjsSwapped: globalThis.__PRE_CJS_SWAPPED__ ?? null,',
      '  preCjsActive: globalThis.__PRE_CJS_ACTIVE__ ?? null,',
      '  preMjsSwapped: globalThis.__PRE_MJS_SWAPPED__ ?? null,',
      '  preMjsActive: globalThis.__PRE_MJS_ACTIVE__ ?? null,',
      '}));',
    ].join('\n'),
  );
});

afterAll(() => {
  if (fixtureDir !== '') {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

async function runSpawnedChild(
  argv: string[],
  baseNodeOptions?: string,
): Promise<{
  mainSwapped: boolean;
  preCjsSwapped: boolean | null;
  preCjsActive: boolean | null;
  preMjsSwapped: boolean | null;
  preMjsActive: boolean | null;
}> {
  const registerUrl = registerModuleUrl();
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: undefined, PYRIC_SANDBOX_FORCE: undefined };
  if (baseNodeOptions === undefined) {
    delete baseEnv.NODE_OPTIONS;
  } else {
    baseEnv.NODE_OPTIONS = baseNodeOptions;
  }
  const childEnv = buildChildEnv(baseEnv, {
    serveUrl: 'http://127.0.0.1:45999',
    registerUrl,
  });
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const handle = spawnSandboxChild({ argv, label: argv.join(' ') }, { cwd: fixtureDir, env: childEnv, json: false });
    expect(await handle.exited).toBe(0);
  } finally {
    process.stdout.write = origWrite;
  }
  const line = chunks
    .join('')
    .split('\n')
    .map((entry) => entry.replace(/^\[dev\]\s*/, '').trim())
    .find((entry) => entry.startsWith('PRELOAD_ORDER_OUT '));
  expect(line).toBeDefined();
  return JSON.parse((line ?? 'PRELOAD_ORDER_OUT {}').slice('PRELOAD_ORDER_OUT '.length));
}

describe('buildChildEnv and spawnSandboxChild preload ordering (#1588, #1619)', () => {
  it('places canonical register preload ahead of user --require and --import in NODE_OPTIONS', () => {
    const registerUrl = 'file:///app/node_modules/@pyric/cli/dist/register/index.js';
    const registerPath = fileURLToPath(registerUrl);
    for (const userNodeOptions of [
      '--import ./pre.mjs',
      '--import=./pre.mjs',
      '--require ./pre.cjs',
      '-r ./pre.cjs',
      '--require ./pre.cjs --import ./pre.mjs',
    ]) {
      const env = buildChildEnv({ NODE_OPTIONS: userNodeOptions }, { serveUrl: 'http://127.0.0.1:3473', registerUrl });
      const nodeOptions = env.NODE_OPTIONS ?? '';
      expect(nodeOptions.startsWith(`--require ${registerPath} --import ${registerUrl} `)).toBe(true);
      expect(hasPreloadBeforeRegister(nodeOptions, registerUrl)).toBe(false);
    }
  });

  it('swaps firebase-admin inside CLI --require, NODE_OPTIONS --require, and NODE_OPTIONS --import preloads', async () => {
    const nodeBin = process.env.PYRIC_TEST_NODE ?? 'node';

    const cliRequire = await runSpawnedChild([nodeBin, '--require', './pre.cjs', 'main.mjs']);
    expect(cliRequire).toEqual({
      mainSwapped: true,
      preCjsSwapped: true,
      preCjsActive: true,
      preMjsSwapped: null,
      preMjsActive: null,
    });

    const envRequire = await runSpawnedChild([nodeBin, 'main.mjs'], '--require ./pre.cjs');
    expect(envRequire).toEqual({
      mainSwapped: true,
      preCjsSwapped: true,
      preCjsActive: true,
      preMjsSwapped: null,
      preMjsActive: null,
    });

    const envImport = await runSpawnedChild([nodeBin, 'main.mjs'], '--import ./pre.mjs');
    expect(envImport).toEqual({
      mainSwapped: true,
      preCjsSwapped: null,
      preCjsActive: null,
      preMjsSwapped: true,
      preMjsActive: true,
    });
  }, 30_000);
});
