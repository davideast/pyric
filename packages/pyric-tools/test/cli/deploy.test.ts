/**
 * `runDeploy` dispatch — the strangler-fig path for a registered provider
 * (functions). Focuses on the contract invariants: usage errors exit 1 BEFORE
 * any network, unknown/missing targets exit 1. The happy-path execute is covered
 * by the factory's own global-fetch test (test/deploy/tools.test.ts).
 */
import { describe, it, expect } from 'bun:test';
import { runDeploy, type DeployDeps } from '../../src/cli/deploy.js';
import type { ParsedArgs } from '../../src/cli/parse-args.js';

function parsed(positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return { positional, flags: new Map(Object.entries(flags)) } as ParsedArgs;
}

function harness(over: Partial<DeployDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: DeployDeps = {
    resolveScope: async () => ({
      scope: { projectId: 'demo', resolveToken: async () => 'tkn' },
      source: 'test',
    }),
    readFirebaseJson: async () => ({}),
    readFirebaseRc: async () => null,
    cwd: '/proj',
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    ...over,
  };
  return { deps, out, err };
}

describe('runDeploy dispatch', () => {
  it('missing target -> exit 1', async () => {
    const { deps, err } = harness();
    expect(await runDeploy(parsed([]), deps)).toBe(1);
    expect(err.join('')).toContain('missing target');
  });

  it('unknown target -> exit 1', async () => {
    const { deps, err } = harness();
    expect(await runDeploy(parsed(['bogus']), deps)).toBe(1);
    expect(err.join('')).toContain('unknown target');
  });

  it('functions without --source -> exit 1 (usage, before any network)', async () => {
    const { deps, err } = harness();
    expect(await runDeploy(parsed(['functions'], { config: '[]' }), deps)).toBe(1);
    expect(err.join('')).toContain('--source');
  });

  it('functions without --config -> exit 1', async () => {
    const { deps, err } = harness();
    expect(await runDeploy(parsed(['functions'], { source: 'fns' }), deps)).toBe(1);
    expect(err.join('')).toContain('--config');
  });

  it('functions with unparseable --config -> exit 1', async () => {
    const { deps, err } = harness();
    expect(await runDeploy(parsed(['functions'], { source: 'fns', config: '[nope' }), deps)).toBe(1);
    expect(err.join('')).toContain('parse');
  });

  it('storage is an accepted target (registry-based accept-list), usage error without a block', async () => {
    const { deps, err } = harness();
    const code = await runDeploy(parsed(['storage']), deps);
    expect(code).toBe(1);
    expect(err.join('')).not.toContain('unknown target'); // accepted, reached resolveConfig
    expect(err.join('')).toContain('storage');
  });

  it('database is an accepted target, usage error without a database block', async () => {
    const { deps, err } = harness();
    const code = await runDeploy(parsed(['database']), deps);
    expect(code).toBe(1);
    expect(err.join('')).not.toContain('unknown target');
    expect(err.join('')).toContain('database.rules');
  });

  it('login user lacking cloud-platform -> scope-upgrade preflight fails fast', async () => {
    const { deps, err } = harness({
      resolveScope: async () => ({
        scope: { projectId: 'demo', resolveToken: async () => 'tkn' },
        source: 'login',
        grantedScopes: ['https://www.googleapis.com/auth/firebase'],
      }),
    });
    expect(await runDeploy(parsed(['storage']), deps)).toBe(1);
    expect(err.join('')).toContain('cloud-platform'); // the preflight fires before resolveConfig
    expect(err.join('')).toContain('pyric login');
  });

  it('login user WITH the required scope passes the preflight (reaches config)', async () => {
    const { deps, err } = harness({
      resolveScope: async () => ({
        scope: { projectId: 'demo', resolveToken: async () => 'tkn' },
        source: 'login',
        grantedScopes: ['https://www.googleapis.com/auth/firebase'],
      }),
    });
    expect(await runDeploy(parsed(['hosting']), deps)).toBe(1);
    expect(err.join('')).not.toContain('cloud-platform'); // preflight passed (firebase covers hosting)
    expect(err.join('')).toContain('hosting'); // reached resolveConfig
  });

  it('login user lacking firebase.database -> scope-upgrade preflight fails fast', async () => {
    const { deps, err } = harness({
      resolveScope: async () => ({
        scope: { projectId: 'demo', resolveToken: async () => 'tkn' },
        source: 'login',
        grantedScopes: ['https://www.googleapis.com/auth/firebase'],
      }),
    });
    expect(await runDeploy(parsed(['database']), deps)).toBe(1);
    expect(err.join('')).toContain('firebase.database');
    expect(err.join('')).toContain('pyric login');
  });
});
