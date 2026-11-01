/**
 * The RTDB instances a project's files and its sandbox make known to the
 * `database` methods, when no host answers for them.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdminDatabase } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';

import { projectDatabaseInstances } from '../../../src/bridge/surface/database-instance-project.js';

function project(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-instance-catalog-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(content));
  return dir;
}

describe('projectDatabaseInstances', () => {
  it('knows the declared instances, the held ones, and the default by its project name', async () => {
    const sandbox = initializeSandbox();
    getAdminDatabase(sandbox, 'runtime-only');
    const dir = project({
      'firebase.json': { database: [{ instance: 'demo-default-rtdb', rules: 'a.json' }, { instance: 'shard-00', rules: 'a.json' }] },
      '.firebaserc': { projects: { default: 'demo' } },
    });
    const catalog = await projectDatabaseInstances(sandbox, dir);
    expect(catalog.known()).toEqual({ defaultInstance: 'demo-default-rtdb', named: ['shard-00', 'runtime-only'], pending: [] });
    expect(catalog.select('demo-default-rtdb')).toBeUndefined();
    expect(catalog.select('runtime-only')).toBe('runtime-only');
    expect(catalog.select('shard-09')).toBeNull();
  });

  it('reports a target no project resolves', async () => {
    const dir = project({ 'firebase.json': { database: [{ target: 'main', rules: 'a.json' }] } });
    const catalog = await projectDatabaseInstances(initializeSandbox(), dir);
    expect(catalog.known().pending).toEqual([
      'firebase.json database[0] target "main" selects no instance yet: no Firebase project is set.',
    ]);
  });

  it('knows only the default instance without a firebase.json', async () => {
    const catalog = await projectDatabaseInstances(initializeSandbox(), project({}));
    expect(catalog.known()).toEqual({ named: [], pending: [] });
  });
});
