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

const SPECIFIER = /^@pyric\/cli\/next\/sdk\/[a-z-]+$/;

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

  it('sends firebase/firestore/lite to the deferred lite entry, not the full Firestore entry', async () => {
    const aliases = getClientAliases();
    expect(aliases['firebase/firestore/lite']).toBe('@pyric/cli/next/sdk/firestore-lite');
    const lite = (await import(aliases['firebase/firestore/lite']!)) as Record<string, () => unknown>;
    expect(() => lite.getFirestore!()).toThrow("pyric: 'firebase/firestore/lite' is not yet mirrored by the local sandbox.");
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
