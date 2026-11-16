import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { withPyric } from '../../../src/next/index.js';
import { markRegisterActive } from '../../../src/register/activation.js';

/** The register's activation mark (`src/register/activation.ts`). */
const REGISTER_ACTIVE = Symbol.for('pyric.register.active');

async function resolveWith(config: any): Promise<Record<string, any>> {
  const wrapped = withPyric(config) as (phase: string, defaults: Record<string, any>) => Promise<Record<string, any>>;
  return wrapped('phase-development-server', {});
}

describe('withPyric webpack ordering', () => {
  const saved = process.env.PYRIC_SANDBOX;
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.PYRIC_SANDBOX = 'remote:http://127.0.0.1:4000';
    markRegisterActive();
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[REGISTER_ACTIVE];
    process.env.NODE_ENV = savedNodeEnv;
    if (saved === undefined) delete process.env.PYRIC_SANDBOX;
    else process.env.PYRIC_SANDBOX = saved;
  });

  it('applies the Pyric aliases after the user webpack function, so the user cannot erase them', async () => {
    const userWebpack = (cfg: any) => {
      cfg.resolve = { alias: {} };
      return cfg;
    };
    const res = await resolveWith({ webpack: userWebpack });
    const result = res.webpack({}, { isServer: false });
    expect(result.resolve.alias['firebase/app$']).toBe('@pyric/cli/next/internal/app');
  });

  it('applies the Pyric aliases to a config object the user webpack function returns', async () => {
    const userWebpack = () => ({ resolve: { alias: { mine: 'x' } } });
    const res = await resolveWith({ webpack: userWebpack });
    const result = res.webpack({}, { isServer: false });
    expect(result.resolve.alias.mine).toBe('x');
    expect(result.resolve.alias['firebase/app$']).toBe('@pyric/cli/next/internal/app');
  });

  it('leaves server builds to the user webpack function alone', async () => {
    const userWebpack = (cfg: any) => Object.assign(cfg, { touched: true });
    const res = await resolveWith({ webpack: userWebpack });
    const result = res.webpack({}, { isServer: true });
    expect(result.touched).toBe(true);
    expect(result.resolve).toBeUndefined();
  });

  it('preserves Webpack 5 array-form resolve.alias with Pyric exact entries first and user aliases intact', async () => {
    const userAliases = [
      { name: 'firebase/app', alias: './user-override', onlyModule: true },
      { name: '@items', alias: './src/items', onlyModule: false },
    ];
    const userWebpack = (cfg: any) => {
      cfg.resolve = { alias: userAliases };
      return cfg;
    };
    const res = await resolveWith({ webpack: userWebpack });
    const result = res.webpack({}, { isServer: false });

    expect(Array.isArray(result.resolve.alias)).toBe(true);
    const aliases = result.resolve.alias as Array<{ name: string; alias: string | false; onlyModule?: boolean }>;
    // Does not mutate the user's input array.
    expect(userAliases).toHaveLength(2);
    // Pyric exact entries use `onlyModule: true` without trailing `$`.
    const appIndex = aliases.findIndex((entry) => entry.name === 'firebase/app');
    const userOverrideIndex = aliases.findIndex(
      (entry) => entry.name === 'firebase/app' && entry.alias === './user-override',
    );
    const itemsIndex = aliases.findIndex((entry) => entry.name === '@items');
    expect(appIndex).toBeGreaterThanOrEqual(0);
    expect(aliases[appIndex]).toEqual({
      name: 'firebase/app',
      alias: '@pyric/cli/next/internal/app',
      onlyModule: true,
    });
    // Pyric swap entry precedes the conflicting user entry (first-match-wins).
    expect(appIndex).toBeLessThan(userOverrideIndex);
    // User non-conflicting alias is preserved verbatim.
    expect(itemsIndex).toBeGreaterThan(appIndex);
    expect(aliases[itemsIndex]).toEqual({ name: '@items', alias: './src/items', onlyModule: false });
    // Unserved Firebase subpaths are stopped with `onlyModule: true` and no `$`.
    const liteEntry = aliases.find((entry) => entry.name === 'firebase/firestore/lite');
    expect(liteEntry).toBeDefined();
    expect(liteEntry?.onlyModule).toBe(true);
    expect(aliases.some((entry) => entry.name.endsWith('$'))).toBe(false);
  });

  it('preserves array-form resolve.fallback and handles resolve.alias: false safely', async () => {
    const userFallbacks = [{ name: 'crypto', alias: './crypto-shim', onlyModule: false }];
    const userWebpack = () => ({
      resolve: {
        alias: false,
        fallback: userFallbacks,
      },
    });
    const res = await resolveWith({ webpack: userWebpack });
    const result = res.webpack({}, { isServer: false });

    expect(result.resolve.alias['firebase/app$']).toBe('@pyric/cli/next/internal/app');
    expect(Array.isArray(result.resolve.fallback)).toBe(true);
    const fallbacks = result.resolve.fallback as Array<{ name: string; alias: string | false; onlyModule?: boolean }>;
    expect(userFallbacks).toHaveLength(1);
    const fsIndex = fallbacks.findIndex((entry) => entry.name === 'fs' && entry.alias === false);
    const cryptoIndex = fallbacks.findIndex((entry) => entry.name === 'crypto' && entry.alias === './crypto-shim');
    expect(fsIndex).toBeGreaterThanOrEqual(0);
    expect(cryptoIndex).toBeGreaterThan(fsIndex);
  });
});
