import { describe, it, expect } from 'bun:test';
import { hostingProvider } from '../../src/deploy/providers/hosting.js';
import { storageProvider } from '../../src/deploy/providers/storage.js';
import { firestoreRulesProvider, firestoreIndexesProvider } from '../../src/deploy/providers/firestore.js';
import { databaseRulesProvider } from '../../src/deploy/providers/database.js';
import type { ConfigSource } from '../../src/deploy/provider.js';
import type { FirebaseJson, FirebaseRc } from '../../src/cli/firebase-json.js';

function src(opts: {
  firebaseJson?: FirebaseJson;
  firebaseRc?: FirebaseRc | null;
  flags?: Record<string, string | boolean>;
  files?: Record<string, string>;
  projectId?: string;
  gitBranch?: string | null;
  env?: Record<string, string | undefined>;
}): ConfigSource {
  return {
    firebaseJson: opts.firebaseJson ?? {},
    firebaseRc: opts.firebaseRc ?? null,
    flags: new Map(Object.entries(opts.flags ?? {})),
    projectId: opts.projectId ?? 'demo',
    cwd: '/proj',
    env: opts.env,
    readFile: async (path) => {
      const f = (opts.files ?? {})[path];
      if (f === undefined) throw new Error(`ENOENT ${path}`);
      return f;
    },
    getGitBranch: async () => opts.gitBranch ?? null,
  };
}

describe('hostingProvider.resolveConfig (plural fan-out)', () => {
  it('usage error with no hosting block', async () => {
    expect((await hostingProvider.resolveConfig('deploy', src({}))).ok).toBe(false);
  });

  it('single object entry -> one unit, localDir resolved', async () => {
    const r = await hostingProvider.resolveConfig('deploy', src({ firebaseJson: { hosting: { site: 's1', public: 'dist' } } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.units).toHaveLength(1);
      expect(r.units[0].siteId).toBe('s1');
      expect(r.units[0].localDir).toBe('/proj/dist');
    }
  });

  it('array defaults to the first entry; --only selects by site', async () => {
    const fj: FirebaseJson = { hosting: [{ site: 'a', public: 'da' }, { site: 'b', public: 'db' }] };
    const def = await hostingProvider.resolveConfig('deploy', src({ firebaseJson: fj }));
    expect(def.ok && def.units[0].siteId).toBe('a');
    const only = await hostingProvider.resolveConfig('deploy', src({ firebaseJson: fj, flags: { only: 'hosting:b' } }));
    expect(only.ok && only.units[0].siteId).toBe('b');
    const miss = await hostingProvider.resolveConfig('deploy', src({ firebaseJson: fj, flags: { only: 'hosting:zzz' } }));
    expect(miss.ok).toBe(false);
  });

  it('a `target` expands to its .firebaserc sites (multi-site units)', async () => {
    const r = await hostingProvider.resolveConfig(
      'deploy',
      src({
        firebaseJson: { hosting: { target: 'prod', public: 'dist' } },
        firebaseRc: { targets: { demo: { hosting: { prod: ['s1', 's2'] } } } } as FirebaseRc,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.units.map((u) => u.siteId)).toEqual(['s1', 's2']);
  });

  it('an unmapped `target` is a usage error', async () => {
    const r = await hostingProvider.resolveConfig('deploy', src({ firebaseJson: { hosting: { target: 'prod', public: 'dist' } } }));
    expect(r.ok).toBe(false);
  });

  it('--channel auto with no git branch is a usage error', async () => {
    const r = await hostingProvider.resolveConfig(
      'deploy',
      src({ firebaseJson: { hosting: { site: 's', public: 'd' } }, flags: { channel: 'auto' }, gitBranch: null }),
    );
    expect(r.ok).toBe(false);
  });

  it('collects warnings for non-serving keys (returned, not stderr)', async () => {
    const r = await hostingProvider.resolveConfig(
      'deploy',
      src({ firebaseJson: { hosting: { site: 's', public: 'd', predeploy: ['echo hi'] } } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.warnings ?? []).length).toBeGreaterThan(0);
  });

  it('REFUSES a pyric sandbox build (index.html carries the marker)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-deploy-sandbox-'));
    mkdirSync(join(cwd, 'dist'));
    writeFileSync(
      join(cwd, 'dist', 'index.html'),
      '<head><meta name="pyric-sandbox-build" content="1" data-pyric-sandbox-build></head>',
    );
    const r = await hostingProvider.resolveConfig('deploy', {
      ...src({ firebaseJson: { hosting: { site: 's1', public: 'dist' } } }),
      cwd,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('SANDBOX build');
  });

  it('allows a normal (unmarked) build dir', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-deploy-prod-'));
    mkdirSync(join(cwd, 'dist'));
    writeFileSync(join(cwd, 'dist', 'index.html'), '<head></head>');
    const r = await hostingProvider.resolveConfig('deploy', {
      ...src({ firebaseJson: { hosting: { site: 's1', public: 'dist' } } }),
      cwd,
    });
    expect(r.ok).toBe(true);
  });
});

describe('storageProvider.resolveConfig (per-bucket)', () => {
  it('usage error with no storage block', async () => {
    expect((await storageProvider.resolveConfig('provision', src({}))).ok).toBe(false);
  });

  it('{ rules } -> one unit carrying the rules SOURCE (not the path)', async () => {
    const r = await storageProvider.resolveConfig(
      'provision',
      src({ firebaseJson: { storage: { rules: 'storage.rules' } }, files: { '/proj/storage.rules': 'rules_version="2";' } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.units).toHaveLength(1);
      expect(r.units[0].rules).toContain('rules_version');
      expect(r.units[0].bucketId).toBeUndefined();
    }
  });

  it('array -> one unit per bucket, with bucket override', async () => {
    const r = await storageProvider.resolveConfig(
      'provision',
      src({
        firebaseJson: { storage: [{ bucket: 'b1', rules: 'r1.rules' }, { bucket: 'b2', rules: 'r2.rules' }] },
        files: { '/proj/r1.rules': 'A', '/proj/r2.rules': 'B' },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.units.map((u) => u.bucketId)).toEqual(['b1', 'b2']);
      expect(r.units[0].rules).toBe('A');
    }
  });
});

describe('firestore providers resolveConfig', () => {
  it('rules: reads the firestore.rules source; missing path is a usage error', async () => {
    const ok = await firestoreRulesProvider.resolveConfig(
      'deploy',
      src({ firebaseJson: { firestore: { rules: 'firestore.rules' } }, files: { '/proj/firestore.rules': 'RULES' } }),
    );
    expect(ok.ok && ok.units[0].source).toBe('RULES');
    expect((await firestoreRulesProvider.resolveConfig('deploy', src({}))).ok).toBe(false);
  });

  it('indexes: parses the JSON; bad JSON is a usage error', async () => {
    const ok = await firestoreIndexesProvider.resolveConfig(
      'deploy',
      src({ firebaseJson: { firestore: { indexes: 'idx.json' } }, files: { '/proj/idx.json': '{"indexes":[]}' } }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.units[0].config as { indexes: unknown[] }).indexes).toEqual([]);
    const bad = await firestoreIndexesProvider.resolveConfig(
      'deploy',
      src({ firebaseJson: { firestore: { indexes: 'idx.json' } }, files: { '/proj/idx.json': '{bad' } }),
    );
    expect(bad.ok).toBe(false);
  });
});

describe('databaseRulesProvider.resolveConfig', () => {
  it('usage error with no database.rules path', async () => {
    expect((await databaseRulesProvider.resolveConfig('deploy', src({}))).ok).toBe(false);
  });

  it('reads RTDB rules JSON and honors --database-url', async () => {
    const r = await databaseRulesProvider.resolveConfig(
      'deploy',
      src({
        firebaseJson: { database: { rules: 'database.rules.json' } },
        flags: { 'database-url': 'https://demo-default-rtdb.firebaseio.com' },
        files: { '/proj/database.rules.json': '{"rules":{".read":false}}' },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.units[0].databaseUrl).toBe('https://demo-default-rtdb.firebaseio.com');
      expect(r.units[0].rulesJson).toEqual({ rules: { '.read': false } });
    }
  });

  it('uses FIREBASE_DATABASE_URL when no flag is present', async () => {
    const r = await databaseRulesProvider.resolveConfig(
      'deploy',
      src({
        firebaseJson: { database: { rules: 'database.rules.json' } },
        env: { FIREBASE_DATABASE_URL: 'https://env-db.firebaseio.com' },
        files: { '/proj/database.rules.json': '{"rules":{".read":true}}' },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.units[0].databaseUrl).toBe('https://env-db.firebaseio.com');
  });
});
