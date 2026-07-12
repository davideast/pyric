import { describe, it, expect } from 'bun:test';
import { DEPLOY_PROVIDERS, providerByTarget } from '../../src/deploy/registry.js';
import { functionsProvider } from '../../src/deploy/providers/functions.js';
import type { ConfigSource } from '../../src/deploy/provider.js';
import type { ProjectScope } from '../../src/deploy/scope.js';

const stubScope: ProjectScope = {
  projectId: '(test)',
  resolveToken: async () => {
    throw new Error('registry self-test must not mint tokens');
  },
};

function src(flags: Record<string, string | boolean>, files: Record<string, string> = {}): ConfigSource {
  return {
    firebaseJson: {},
    firebaseRc: null,
    flags: new Map(Object.entries(flags)),
    projectId: 'demo',
    cwd: '/proj',
    readFile: async (path) => {
      const f = files[path];
      if (f === undefined) throw new Error(`ENOENT ${path}`);
      return f;
    },
    getGitBranch: async () => null,
  };
}

describe('deploy registry', () => {
  it('every operation resolves to a real tool (no dangling toolName)', () => {
    for (const p of DEPLOY_PROVIDERS) {
      const tools = p.tools(stubScope);
      for (const op of p.operations) {
        expect(
          tools.find((t) => t.name === op.toolName),
          `${p.target}:${op.name} -> ${op.toolName}`,
        ).toBeDefined();
      }
      expect(p.operations.filter((o) => o.default).length, `${p.target} default ops`).toBeLessThanOrEqual(1);
    }
  });

  it('providerByTarget keys match the array (single source of truth)', () => {
    expect([...providerByTarget.keys()].sort()).toEqual(DEPLOY_PROVIDERS.map((p) => p.target).sort());
  });
});

describe('functionsProvider.resolveConfig (pure — no network, no scope)', () => {
  it('usage error when --source is missing', async () => {
    const r = await functionsProvider.resolveConfig('deploy', src({ config: '[]' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--source');
  });

  it('usage error when --config is missing', async () => {
    const r = await functionsProvider.resolveConfig('deploy', src({ source: 'fns' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--config');
  });

  it('usage error when --config is unparseable', async () => {
    const r = await functionsProvider.resolveConfig('deploy', src({ source: 'fns', config: '[nope' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('parse');
  });

  it('parses inline JSON --config into one unit, paths resolved against cwd', async () => {
    const r = await functionsProvider.resolveConfig('deploy', src({ source: 'fns', config: '[{"name":"api"}]' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.units).toHaveLength(1);
      expect(r.units[0].localDir).toBe('/proj/fns');
      expect(r.units[0].functions).toEqual([{ name: 'api' }]);
    }
  });

  it('reads a --config file path', async () => {
    const r = await functionsProvider.resolveConfig(
      'deploy',
      src({ source: 'fns', config: 'fns.json' }, { '/proj/fns.json': '[{"name":"worker"}]' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.units[0].functions).toEqual([{ name: 'worker' }]);
  });
});
