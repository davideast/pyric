import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { withPyric } from '../../../src/next/index.js';

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
  });

  afterEach(() => {
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
});
