/**
 * The aliases `withPyric` gives Webpack and Turbopack for client `firebase/*`
 * imports. Turbopack reads an absolute alias path as relative to the project
 * root, so every alias names a package specifier that `@pyric/cli` exports,
 * which both bundlers resolve from the application's own dependencies.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getClientAliases } from '../../../src/next/client-aliases.js';
import { bridgeImportOptions } from '../../../src/next/bridge-imports.js';
import bridgeImportLoader from '../../../src/next/bridge-import-loader.js';
import { isBypassedBridgeImport, swappedFirebaseEntries } from '../../../src/serve/firebase-module-swap.js';

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

  it('sends firebase/app-check to the App Check mirror', async () => {
    const aliases = getClientAliases();
    expect(aliases['firebase/app-check']).toBe('@pyric/cli/next/internal/app-check');
    const mod = (await import(aliases['firebase/app-check']!)) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual([
      'CustomProvider', 'ReCaptchaEnterpriseProvider', 'ReCaptchaV3Provider', 'getLimitedUseToken',
      'getToken', 'initializeAppCheck', 'onTokenChanged', 'setTokenAutoRefreshEnabled',
    ]);
  });

  it('aliases no @firebase/* package', () => {
    const scoped = Object.keys(getClientAliases()).filter((source) => source.startsWith('@firebase/'));
    expect(scoped).toEqual([]);
  });
});

describe('client aliases in production AI mode (#1637)', () => {
  it('reads the swap table every plane reads, so firebase/ai is left to the Firebase SDK', () => {
    for (const mode of ['sandbox', 'production'] as const) {
      const expected = Object.fromEntries(
        [...swappedFirebaseEntries(mode)].map(([source, entry]) => [source, `@pyric/cli/next/internal/${entry}`]),
      );
      expect(getClientAliases(mode)).toEqual(expected);
    }
    const production = getClientAliases('production');
    expect(production['firebase/ai']).toBeUndefined();
    expect(production['firebase/app']).toBe('@pyric/cli/next/internal/app-ai-passthrough');
    expect(production['firebase/app-check']).toBe('@pyric/cli/next/internal/app-ai-passthrough-app-check');
  });

  it('resolves every production alias through the @pyric/cli exports map', () => {
    for (const [source, target] of Object.entries(getClientAliases('production'))) {
      const file = fileURLToPath(import.meta.resolve(target));
      expect(existsSync(file), `${source} -> ${target}`).toBe(true);
    }
  });

  it('defaults to the mode PYRIC_AI_MODE names', () => {
    const previous = process.env.PYRIC_AI_MODE;
    process.env.PYRIC_AI_MODE = 'production';
    try {
      expect(getClientAliases()['firebase/ai']).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PYRIC_AI_MODE;
      else process.env.PYRIC_AI_MODE = previous;
    }
  });
});

describe('the bridge import loader (#1637)', () => {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const options = bridgeImportOptions();

  it('rewrites only the bypassed import of each shadow-app wrapper, to the Firebase SDK browser file', () => {
    const entries = Object.entries(options.wrappers);
    expect(entries.map(([, specifier]) => specifier).sort()).toEqual(['firebase/app', 'firebase/app-check']);
    for (const [wrapper, specifier] of entries) {
      expect(isBypassedBridgeImport(specifier, wrapper)).toBe(true);
      const loaded = bridgeImportLoader.call(
        { resourcePath: wrapper, rootContext: projectRoot, getOptions: () => options },
        readFileSync(wrapper, 'utf8'),
      );
      expect(loaded).not.toContain(`from '${specifier}'`);
      const target = loaded.match(/from '(\.[^']*\/firebase\/[^']+)'/)?.[1];
      expect(target).toBeDefined();
      const file = fileURLToPath(new URL(target!, pathToFileURL(wrapper)));
      expect(file).toMatch(new RegExp(`/firebase/${specifier.slice('firebase/'.length)}/dist/esm/index\\.esm\\.js$`));
      expect(existsSync(file), file).toBe(true);
    }
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
