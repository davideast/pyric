/**
 * The Realtime Database instances firebase.json names for the live project
 * (`admin/database-instances.ts`), which the Admin Realtime Database row lets
 * through beside `<project>` and `<project>-*`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredDatabaseInstances } from '../src/admin/database-instances.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function projectWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'live-database-instances-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

describe('the instances firebase.json names', () => {
  test("reads each instance, and each target through .firebaserc for the live project only, lowercase and once", () => {
    const dir = projectWith({
      'firebase.json': { database: [{ instance: 'Team-Ledger', rules: 'a.json' }, { target: 'main', rules: 'b.json' }, { instance: 'team-ledger' }] },
      '.firebaserc': { projects: { default: 'demo' }, targets: { demo: { database: { main: ['orders-eu'] } }, other: { database: { main: ['not-ours'] } } } },
    });
    expect(configuredDatabaseInstances(dir, 'demo')).toEqual(['team-ledger', 'orders-eu']);
  });

  test('names none for a single rules entry, no firebase.json, or a file that does not parse', () => {
    expect(configuredDatabaseInstances(projectWith({ 'firebase.json': { database: { rules: 'a.json' } } }), 'demo')).toEqual([]);
    expect(configuredDatabaseInstances(projectWith({}), 'demo')).toEqual([]);
    expect(configuredDatabaseInstances(projectWith({ 'firebase.json': '{ not json' }), 'demo')).toEqual([]);
  });
});
