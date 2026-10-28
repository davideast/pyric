/**
 * `pyric database <method> --instance <projectId>` selects the default
 * instance, as the legacy `https://<projectId>.firebaseio.com` URL names it
 * (#1062).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';

import { projectDatabaseInstances } from '../../../src/bridge/surface/database-instance-project.js';

const PROJECT = 'legacy-catalog';

function project(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-instance-catalog-legacy-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(content));
  return dir;
}

describe('the database instance catalog with the legacy default instance name', () => {
  it('selects the default instance for <projectId> and its legacy URL', async () => {
    const dir = project({
      'firebase.json': { database: { rules: 'database.rules.json' } },
      '.firebaserc': { projects: { default: PROJECT } },
    });
    const catalog = await projectDatabaseInstances(initializeSandbox(), dir);
    expect(catalog.select(`${PROJECT}-default-rtdb`)).toBeUndefined();
    expect(catalog.select(PROJECT)).toBeUndefined();
  });

  it('does not list a firebase.json entry for <projectId> as a named instance', async () => {
    const dir = project({
      'firebase.json': { database: [{ instance: PROJECT, rules: 'a.json' }, { instance: 'shard-00', rules: 'a.json' }] },
      '.firebaserc': { projects: { default: PROJECT } },
    });
    const catalog = await projectDatabaseInstances(initializeSandbox(), dir);
    expect(catalog.known()).toEqual({ defaultInstance: `${PROJECT}-default-rtdb`, named: ['shard-00'], pending: [] });
    expect(catalog.select(PROJECT)).toBeUndefined();
  });
});
