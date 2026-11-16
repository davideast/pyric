import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';

import admin, { SDK_VERSION } from '../../src/index.js';
import * as modularApp from '../../src/app/index.js';

const packageRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(packageRoot, '../..');
const builtRootEntry = join(packageRoot, 'dist/index.js');
const builtSandboxEntry = join(repoRoot, 'packages/pyric/dist/sandbox/index.js');

afterEach(async () => {
  await Promise.all(modularApp.getApps().map((app) => modularApp.deleteApp(app)));
});

describe('pyric-admin root facade', () => {
  it('exposes SDK_VERSION, live apps array, and non-enumerable default self-reference', async () => {
    expect(typeof SDK_VERSION).toBe('string');
    expect(SDK_VERSION.length).toBeGreaterThan(0);
    expect(admin.SDK_VERSION).toBe(SDK_VERSION);
    expect('SDK_VERSION' in modularApp).toBe(false);

    expect(Array.isArray(admin.apps)).toBe(true);
    expect(admin.apps).toHaveLength(0);

    const descriptor = Object.getOwnPropertyDescriptor(admin, 'default');
    expect(descriptor?.enumerable).toBe(false);
    expect((admin as unknown as { default: unknown }).default).toBe(admin);

    const sandbox = initializeSandbox();
    const app = admin.initializeApp({ sandbox, projectId: 'demo-project' }, 'items-app');
    expect(admin.apps).toHaveLength(1);
    expect(admin.apps[0]?.name).toBe('items-app');

    await modularApp.deleteApp(app);
    expect(admin.apps).toHaveLength(0);
  });

  it('returns the live admin facade directly through Node require(esm)', () => {
    if (!existsSync(builtRootEntry) || !existsSync(builtSandboxEntry)) {
      throw new Error('Built pyric/pyric-admin dist missing. Run scripts/build.sh --packages-only first.');
    }
    const script = [
      'import { createRequire } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      'const { initializeSandbox } = await import(pathToFileURL(process.env.PYRIC_SANDBOX_DIST).href);',
      'const req = createRequire(import.meta.url);',
      'const admin = req(process.env.PYRIC_ADMIN_DIST);',
      'const initialCount = Array.isArray(admin.apps) ? admin.apps.length : -1;',
      'const app = admin.initializeApp({ sandbox: initializeSandbox(), projectId: "demo-project" }, "items-app");',
      'const afterCount = Array.isArray(admin.apps) ? admin.apps.length : -1;',
      'const defaultMatches = admin.default === admin;',
      'const defaultAppsCount = Array.isArray(admin.default?.apps) ? admin.default.apps.length : -1;',
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
