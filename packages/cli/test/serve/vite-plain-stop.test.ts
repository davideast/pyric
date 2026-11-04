/**
 * A plain `pyric()` Vite app, with no supplied rows, keeps the stop for every
 * real `firebase/*` and `firebase-admin` import (ADR 0022). Only supplied
 * rows open it, and only for a row module's own import
 * (`vite-supplied-rows.test.ts`). Every subpath the installed packages
 * export is checked, so a new one in a Firebase release is covered too.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SDK_MODULES } from '../../src/serve/firebase-module-swap.js';
import { createViteModuleContext, createViteModuleSwap, type SwapEnvironment } from '../../src/serve/vite-module-swap.js';
import { viteProcessStopHook } from '../../src/serve/vite-process-stop.js';
import { SSR_SWAP_PREFIX } from '../../src/serve/vite-ssr-routing.js';

const require = createRequire(import.meta.url);
const STOP_PREFIX = '\0pyric-stop:';
const userImporter = '/some/app/src/main.ts';
const appFile = pathToFileURL('/app/node_modules/local-lib/index.js').href;
const context = createViteModuleContext();
const entries = new Set(Object.values(context.entries));
const served: ReadonlySet<string> = new Set(SDK_MODULES);

/** Every subpath a package's `exports` names, as a specifier. */
function exportedSpecifiers(name: string, packageJson: string): string[] {
  const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { exports: Record<string, unknown> };
  return Object.keys(manifest.exports)
    .filter((subpath) => subpath !== './package.json')
    .map((subpath) => (subpath === '.' ? name : `${name}/${subpath.slice(2)}`));
}

/** The package.json of a package whose exports hide it, found from its main entry. */
function packageJsonOf(name: string): string {
  let dir = dirname(require.resolve(name));
  while (!dir.endsWith(`/node_modules/${name}`)) dir = dirname(dir);
  return join(dir, 'package.json');
}

const firebaseSpecifiers = exportedSpecifiers('firebase', require.resolve('firebase/package.json'));
const adminSpecifiers = exportedSpecifiers('firebase-admin', packageJsonOf('firebase-admin'));
const clientEnvironment: SwapEnvironment = { name: 'client', config: { consumer: 'client' } };

/** The id a row module of `@pyric/live` would have; a plain app gives it no special handling. */
const suppliedLookingImporter = '\0pyric-live:firebase/firestore';

describe('a plain pyric() Vite app keeps the real-SDK stop', () => {
  const swap = createViteModuleSwap(context);

  it('checks every subpath the installed firebase and firebase-admin export', () => {
    expect(firebaseSpecifiers).toContain('firebase/firestore');
    expect(firebaseSpecifiers).toContain('firebase/compat/app');
    expect(adminSpecifiers).toContain('firebase-admin');
    expect(adminSpecifiers).toContain('firebase-admin/firestore');
  });

  it('gives every firebase/* import on the page a pyric entry or the stop, from any importer', () => {
    for (const importer of [userImporter, '/app/node_modules/a-library/index.js', suppliedLookingImporter]) {
      for (const specifier of firebaseSpecifiers) {
        const id = swap.resolveId(specifier, importer);
        const isServed = served.has(specifier);
        if (isServed) expect(entries.has(id as string)).toBe(true);
        else expect(id).toStartWith(STOP_PREFIX);
      }
    }
  });

  it('gives every firebase-admin import on the page the stop', async () => {
    const fake = { environment: clientEnvironment, resolve: async () => null };
    for (const specifier of adminSpecifiers) {
      const id = await swap.resolvePluginId(fake, `${SSR_SWAP_PREFIX}${specifier}`, userImporter);
      expect(id).toStartWith(STOP_PREFIX);
    }
  });

  it('stops every native load of a real firebase or firebase-admin file in the dev server process', () => {
    const hook = viteProcessStopHook({ getAiMode: () => 'sandbox', write: () => undefined });
    for (const specifier of [...firebaseSpecifiers, ...adminSpecifiers]) {
      const url = pathToFileURL(require.resolve(specifier)).href;
      let code: unknown;
      try {
        hook(specifier, { parentURL: appFile }, () => ({ url }));
      } catch (error) {
        code = (error as { code?: unknown }).code;
      }
      expect({ specifier, code }).toEqual({ specifier, code: 'PYRIC_REAL_SDK_STOPPED' });
    }
  });
});
