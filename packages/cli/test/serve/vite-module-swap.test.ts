import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { SDK_MODULES, pyricPackageRoot } from '../../src/serve/bundler.js';
import {
  createViteModuleContext,
  createViteModuleSwap,
} from '../../src/serve/vite-module-swap.js';

const context = createViteModuleContext();
const swap = createViteModuleSwap(context);
const userImporter = '/some/app/src/main.ts';
const pyricImporter = path.join(pyricPackageRoot(), 'dist', 'firestore', 'index.js');

describe('Vite module swap', () => {
  it('swaps every served Firebase entry for app and dependency importers', () => {
    for (const specifier of SDK_MODULES) {
      const key = specifier.slice('firebase/'.length).replaceAll('/', '-');
      expect(swap.resolveId(specifier, userImporter)).toBe(context.entries[key]);
      expect(swap.resolveId(specifier, '/app/node_modules/a-library/index.js')).toBe(
        context.entries[key],
      );
    }
  });

  it('leaves unrelated and unserved imports alone', () => {
    expect(swap.resolveId('react', userImporter)).toBeNull();
    expect(swap.resolveId('firebase/not-served', userImporter)).toBeNull();
    expect(swap.resolveId('pyric/firestore', userImporter)).toBeNull();
  });

  it('shims Node builtins only for Pyric-owned code', () => {
    expect(swap.resolveId('node:fs', pyricImporter)).toBe('\0pyric:node-shim:fs');
    expect(swap.resolveId('path', pyricImporter)).toBe('\0pyric:node-shim:path');
    expect(swap.resolveId('node:fs', userImporter)).toBeNull();
    expect(swap.resolveId('fs', '/app/node_modules/a-library/index.js')).toBeNull();
  });

  it('loads only its Node shim namespace', () => {
    expect(swap.load('\0pyric:node-shim:fs')).toContain('readFileSync');
    expect(swap.load('\0pyric:node-shim:path')).toContain('export const join');
    expect(swap.load('\0some/other/id')).toBeNull();
  });

  it('configures both optimizer exclusion and its esbuild mirror', () => {
    const config = swap.config();
    expect(config.optimizeDeps?.exclude).toEqual([...SDK_MODULES]);
    expect(config.optimizeDeps?.include).toEqual(['js-md5', 'js-sha256']);
    expect(config.optimizeDeps?.esbuildOptions?.plugins).toHaveLength(1);
  });

  it('augments rather than replaces Vite filesystem allowances', () => {
    const resolved = { server: { fs: { allow: ['/the/app/root'] } } };
    swap.configResolved(resolved as never);
    expect(resolved.server.fs.allow).toContain('/the/app/root');
    expect(resolved.server.fs.allow).toContain(pyricPackageRoot());
    expect(
      resolved.server.fs.allow.some((dir) => context.entries.init.startsWith(dir + path.sep)),
    ).toBe(true);
  });
});
