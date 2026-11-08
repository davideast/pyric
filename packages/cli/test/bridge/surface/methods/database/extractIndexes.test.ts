/**
 * Behavioral tests for `database.extractIndexes` (`extract_database_indexes`):
 * static RTDB `.indexOn` extraction across source paths inside `projectDir`,
 * multi-instance target selection, non-destructive `.indexOn` merge preview,
 * literal-sibling wildcard-shadowing diagnostics, and `projectPathWithin`
 * boundary enforcement.
 */
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import { finishHandlerSuite, projectDir, run } from '../../handler-harness.js';

const surface = renderSurface(undefined);

function callInProject(dir: string, args: Record<string, unknown> = {}) {
  const tool = surface.tools.find((candidate) => candidate.name === 'database');
  if (!tool) throw new Error('no rendered tool named database');
  return tool.execute(
    { method: 'extractIndexes', args },
    createSurfaceContext(initializeSandbox(), dir),
  );
}

describe('database.extractIndexes', () => {
  const subDir = 'rtdb-idx-src';

  afterAll(() => {
    const planted = join(projectDir, subDir);
    if (existsSync(planted)) rmSync(planted, { recursive: true, force: true });
    finishHandlerSuite('database-extract-indexes');
  });

  it('extracts .indexOn requirements from project source paths without mutating disk', async () => {
    mkdirSync(join(projectDir, subDir), { recursive: true });
    writeFileSync(
      join(projectDir, subDir, 'queries.ts'),
      `
import { getDatabase, ref, query, orderByChild, orderByValue, equalTo } from 'firebase/database';

export function activeItems(db: ReturnType<typeof getDatabase>, groupId: string) {
  const members = query(ref(db, \`groups/\${groupId}/members\`), orderByChild('role'), equalTo('admin'));
  const scores = query(ref(db, 'scores'), orderByValue());
  return { members, scores };
}
`,
      'utf8',
    );

    const result = await run('database.extractIndexes', { paths: [subDir] });
    expect(result.ok).toBe(true);
    const data = result.data as {
      requirements: Array<{ path: string; indexOn: string[] }>;
      mergedRules: Record<string, unknown>;
      changed: boolean;
      addedCount: number;
      diagnostics: unknown[];
    };
    expect(data.requirements.map((req) => ({ path: req.path, indexOn: req.indexOn }))).toEqual([
      { path: 'groups/$groupId/members', indexOn: ['role'] },
      { path: 'scores', indexOn: ['.value'] },
    ]);
    expect(data.changed).toBe(true);
    expect(data.addedCount).toBe(2);
    expect(data.mergedRules).toEqual({
      rules: {
        groups: {
          $groupId: {
            members: {
              '.indexOn': ['role'],
            },
          },
        },
        scores: {
          '.indexOn': '.value',
        },
      },
    });
    expect(existsSync(join(projectDir, 'database.rules.json'))).toBe(false);
  });

  it('reports missing-index diagnostics including literal-sibling wildcard shadowing when check is true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-db-extract-check-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'src/feed.ts'),
        `
import { getDatabase, ref, query, orderByChild } from 'firebase/database';
const db = getDatabase();
export function listOrgMembers(orgId: string) {
  return query(ref(db, \`orgs/\${orgId}/members\`), orderByChild('joinedAt'));
}
`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'database.rules.json'),
        JSON.stringify(
          {
            rules: {
              orgs: {
                $orgId: {
                  members: {
                    '.read': 'auth != null',
                    '.indexOn': ['joinedAt'],
                  },
                },
                special: {
                  members: {
                    '.read': 'auth != null',
                  },
                },
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );
      const originalDisk = readFileSync(join(dir, 'database.rules.json'), 'utf8');

      const result = await callInProject(dir, { paths: ['src'], check: true });
      expect(result.ok).toBe(true);
      const data = result.data as {
        changed: boolean;
        diagnostics: Array<{ code: string; ruleSite?: { source?: string }; message: string }>;
      };
      expect(data.changed).toBe(true);
      expect(data.diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(
        data.diagnostics.some(
          (diag) =>
            diag.code === 'rtdb-missing-index-on' &&
            diag.ruleSite?.source === '/orgs/special/members',
        ),
      ).toBe(true);
      expect(readFileSync(join(dir, 'database.rules.json'), 'utf8')).toBe(originalDisk);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scopes extraction and target rules file to the requested instance from firebase.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-db-extract-instance-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'firebase.json'),
        JSON.stringify({
          database: [
            { instance: 'app-default-rtdb', rules: 'database.default.json' },
            { instance: 'shard-00', rules: 'database.shard.json' },
          ],
        }),
        'utf8',
      );
      writeFileSync(
        join(dir, '.firebaserc'),
        JSON.stringify({ projects: { default: 'app' } }),
        'utf8',
      );
      writeFileSync(
        join(dir, 'database.default.json'),
        JSON.stringify({ rules: { '.read': false } }),
        'utf8',
      );
      writeFileSync(
        join(dir, 'database.shard.json'),
        JSON.stringify({ rules: { events: { '.read': 'auth != null' } } }),
        'utf8',
      );
      writeFileSync(
        join(dir, 'src/multi.ts'),
        `
import { getDatabase, ref, query, orderByChild } from 'firebase/database';
const primary = getDatabase();
const shard = getDatabase(undefined, 'https://shard-00.firebaseio.com');
export const a = query(ref(primary, 'users'), orderByChild('email'));
export const b = query(ref(shard, 'events'), orderByChild('createdAt'));
`,
        'utf8',
      );

      const shardRes = await callInProject(dir, { paths: ['src'], instance: 'shard-00' });
      expect(shardRes.ok).toBe(true);
      const data = shardRes.data as {
        requirements: Array<{ resourceId: string; path: string; indexOn: string[] }>;
        mergedRules: Record<string, unknown>;
      };
      expect(
        data.requirements.map((req) => ({
          resourceId: req.resourceId,
          path: req.path,
          indexOn: req.indexOn,
        })),
      ).toEqual([{ resourceId: 'shard-00', path: 'events', indexOn: ['createdAt'] }]);
      expect(data.mergedRules).toEqual({
        rules: {
          events: {
            '.read': 'auth != null',
            '.indexOn': ['createdAt'],
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses paths, symlinks, and rulesPath outside the project directory and malformed instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-db-extract-bounds-'));
    const outside = mkdtempSync(join(tmpdir(), 'pyric-db-extract-outside-'));
    try {
      const escapedPath = await callInProject(dir, { paths: ['../outside'] });
      expect(escapedPath.ok).toBe(false);
      expect(escapedPath.summary).toContain('outside the project directory');

      const escapedRules = await callInProject(dir, { rulesPath: '../outside-rules.json' });
      expect(escapedRules.ok).toBe(false);
      expect(escapedRules.summary).toContain('outside the project directory');

      writeFileSync(join(outside, 'secret.ts'), 'export const s = 1;');
      writeFileSync(join(outside, 'secret.rules.json'), '{"rules":{}}');
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'link.ts'));
      symlinkSync(join(outside, 'secret.rules.json'), join(dir, 'link.rules.json'));

      const symlinkPath = await callInProject(dir, { paths: ['link.ts'] });
      expect(symlinkPath.ok).toBe(false);
      expect(symlinkPath.summary).toContain('outside the project directory');

      const symlinkRules = await callInProject(dir, { rulesPath: 'link.rules.json' });
      expect(symlinkRules.ok).toBe(false);
      expect(symlinkRules.summary).toContain('outside the project directory');

      const badInstance = await callInProject(dir, { instance: 'shard_invalid' });
      expect(badInstance.ok).toBe(false);
      expect(badInstance.summary).toContain('is not a database instance');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
