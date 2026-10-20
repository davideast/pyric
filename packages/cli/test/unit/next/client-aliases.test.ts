/**
 * The aliases `withPyric` gives Webpack and Turbopack for client `firebase/*`
 * imports. Turbopack reads an absolute alias path as relative to the project
 * root, so every alias names a package specifier that `@pyric/cli` exports,
 * which both bundlers resolve from the application's own dependencies.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getClientAliases } from '../../../src/next/client-aliases.js';

const SPECIFIER = /^@pyric\/cli\/next\/internal\/[a-z-]+$/;

describe('client aliases', () => {
  it('names a package specifier for every client module', () => {
    const aliases = getClientAliases();
    for (const [source, target] of Object.entries(aliases)) {
      expect(target, source).toMatch(SPECIFIER);
    }
  });

  it('resolves every alias through the @pyric/cli exports map', () => {
    for (const [source, target] of Object.entries(getClientAliases())) {
      const file = fileURLToPath(import.meta.resolve(target));
      expect(existsSync(file), `${source} -> ${target}`).toBe(true);
    }
  });

  it('sends all deferred client subpaths to their deferred entries instead of the real Firebase SDK', async () => {
    const aliases = getClientAliases();
    const cases: ReadonlyArray<readonly [specifier: string, entry: string, exportName: string]> = [
      ['firebase/analytics', 'analytics', 'getAnalytics'],
      ['firebase/app-check', 'app-check', 'initializeAppCheck'],
      ['firebase/firestore/lite', 'firestore-lite', 'getFirestore'],
      ['firebase/functions', 'functions', 'getFunctions'],
      ['firebase/performance', 'performance', 'getPerformance'],
      ['firebase/remote-config', 'remote-config', 'getRemoteConfig'],
    ];
    for (const [specifier, entry, exportName] of cases) {
      expect(aliases[specifier]).toBe(`@pyric/cli/next/internal/${entry}`);
      const mod = (await import(aliases[specifier]!)) as Record<string, () => unknown>;
      expect(() => mod[exportName]!()).toThrow(
        `pyric: '${specifier}' is not yet mirrored by the local sandbox.`,
      );
    }
  });

  it('aliases no @firebase/* package', () => {
    const scoped = Object.keys(getClientAliases()).filter((source) => source.startsWith('@firebase/'));
    expect(scoped).toEqual([]);
  });
});

describe('the flow-treatment loader', () => {
  it('keeps its runtime URL import out of Webpack and Turbopack', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/serve/runtime/flow-treatments/controller.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ url)');
  });
});
