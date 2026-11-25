import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import upstreamAdmin from 'firebase-admin';
import * as upstreamApp from 'firebase-admin/app';
import { initializeSandbox } from 'pyric/sandbox';

import admin, { SDK_VERSION } from '../../src/index.js';
import * as pyricRoot from '../../src/index.js';
import * as modularApp from '../../src/app/index.js';

const packageRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(packageRoot, '../..');
const builtRootEntry = join(packageRoot, 'dist/index.js');
const builtSandboxEntry = join(repoRoot, 'packages/pyric/dist/sandbox/index.js');

afterEach(async () => {
  await Promise.all(modularApp.getApps().map((app) => modularApp.deleteApp(app)));
});

describe('pyric-admin root facade', () => {
  it('exposes the 11 firebase-admin/app symbols, SDK_VERSION, and non-enumerable default self-reference', async () => {
    expect(SDK_VERSION).toBe('14.5.1');
    expect(admin.SDK_VERSION).toBe(SDK_VERSION);
    expect(modularApp.SDK_VERSION).toBe(SDK_VERSION);

    const upstreamDefaultKeys = Object.keys(upstreamAdmin).sort();
    expect(Object.keys(admin).sort()).toEqual(upstreamDefaultKeys);
    expect(Object.keys(upstreamApp).sort()).toEqual(upstreamDefaultKeys);

    const pyricNamedKeys = Object.keys(pyricRoot)
      .filter((key) => key !== 'default' && key !== 'module.exports')
      .sort();
    expect(pyricNamedKeys).toEqual(upstreamDefaultKeys);

    const descriptor = Object.getOwnPropertyDescriptor(admin, 'default');
    expect(descriptor?.enumerable).toBe(false);
    expect((admin as unknown as { default: unknown }).default).toBe(admin);

    const sandbox = initializeSandbox();
    const app = admin.initializeApp({ sandbox, projectId: 'demo-project' }, 'items-app');
    expect(admin.getApps()).toHaveLength(1);
    expect(admin.getApps()[0]?.name).toBe('items-app');
    expect(admin.getApp('items-app')).toBe(app);

    await admin.deleteApp(app);
    expect(admin.getApps()).toHaveLength(0);
  });

  it('returns the admin facade directly through Node require(esm)', () => {
    if (!existsSync(builtRootEntry) || !existsSync(builtSandboxEntry)) {
      throw new Error('Built pyric/pyric-admin dist missing. Run scripts/build.sh --packages-only first.');
    }
    const script = [
      'import { createRequire } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      'const { initializeSandbox } = await import(pathToFileURL(process.env.PYRIC_SANDBOX_DIST).href);',
      'const req = createRequire(import.meta.url);',
      'const admin = req(process.env.PYRIC_ADMIN_DIST);',
      'const initialCount = admin.getApps().length;',
      'const app = admin.initializeApp({ sandbox: initializeSandbox(), projectId: "demo-project" }, "items-app");',
      'const afterCount = admin.getApps().length;',
      'const defaultMatches = admin.default === admin;',
      'const defaultAppsCount = admin.default.getApps().length;',
      'console.log(JSON.stringify({',
      '  sdkVersion: admin.SDK_VERSION,',
      '  initialCount,',
      '  afterCount,',
      '  appName: app.name,',
      '  defaultMatches,',
      '  defaultAppsCount,',
      '}));',
    ].join('\n');
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PYRIC_ADMIN_DIST: builtRootEntry,
        PYRIC_SANDBOX_DIST: builtSandboxEntry,
      },
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(`Node exited ${String(result.status)}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout.trim()) as {
      sdkVersion: unknown;
      initialCount: number;
      afterCount: number;
      appName: string;
      defaultMatches: boolean;
      defaultAppsCount: number;
    };
    expect(parsed).toEqual({
      sdkVersion: SDK_VERSION,
      initialCount: 0,
      afterCount: 1,
      appName: 'items-app',
      defaultMatches: true,
      defaultAppsCount: 1,
    });
  });
});
