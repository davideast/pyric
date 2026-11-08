import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractRtdbIndexesFromPaths,
  resolveRtdbRulesTarget,
} from '../../src/rtdb/extract-indexes.js';

const tempDirs: string[] = [];

function createTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-rtdb-idx-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('extractRtdbIndexesFromPaths and resolveRtdbRulesTarget', () => {
  test('walks directories and explicit files with tsconfig path aliases', async () => {
    const root = createTempProject();
    mkdirSync(join(root, 'src', 'lib'), { recursive: true });
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
      }),
    );
    writeFileSync(
      join(root, 'src', 'lib', 'refs.ts'),
      `
        import { getDatabase, ref } from 'firebase/database';
        declare const app: unknown;
        export const db = getDatabase(app);
        export const orgMembersRef = (orgId: string) => ref(db, \`orgs/\${orgId}/members\`);
      `,
    );
    writeFileSync(
      join(root, 'src', 'queries.ts'),
      `
        import { get, orderByChild, query } from 'firebase/database';
        import { orgMembersRef } from '@/lib/refs';
        export function loadMembers(orgId: string) {
          return get(query(orgMembersRef(orgId), orderByChild('role')));
        }
      `,
    );

    const result = extractRtdbIndexesFromPaths({
      projectDir: root,
      paths: [join(root, 'src')],
    });
    expect(result.warnings).toEqual([]);
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]?.path).toBe('orgs/$orgId/members');
    expect(result.requirements[0]?.indexOn).toEqual(['role']);
  });

  test('resolves multi-instance firebase.json database array and .firebaserc targets', async () => {
    const root = createTempProject();
    writeFileSync(
      join(root, '.firebaserc'),
      JSON.stringify({
        projects: { default: 'demo-proj' },
        targets: {
          'demo-proj': {
            database: {
              analytics: ['analytics-shard'],
            },
          },
        },
      }),
    );
    writeFileSync(
      join(root, 'firebase.json'),
      JSON.stringify({
        database: [
          { instance: 'demo-proj-default-rtdb', rules: 'rules/default.rules.json' },
          { target: 'analytics', rules: 'rules/analytics.rules.json' },
        ],
      }),
    );

    const defTarget = await resolveRtdbRulesTarget({ cwd: root });
    expect(defTarget.rulesPath).toBe(join(root, 'rules', 'default.rules.json'));
    expect(defTarget.includeDefaultInstance).toBe(true);

    const shardTarget = await resolveRtdbRulesTarget({ cwd: root, instance: 'analytics-shard' });
    expect(shardTarget.rulesPath).toBe(join(root, 'rules', 'analytics.rules.json'));
    expect(shardTarget.instance).toBe('analytics-shard');
    expect(shardTarget.includeDefaultInstance).toBe(false);

    const explicitDefaultWithRules = await resolveRtdbRulesTarget({
      cwd: root,
      rulesFlag: 'rules/default.rules.json',
      instance: 'demo-proj-default-rtdb',
    });
    expect(explicitDefaultWithRules.rulesPath).toBe(join(root, 'rules', 'default.rules.json'));
    expect(explicitDefaultWithRules.includeDefaultInstance).toBe(true);
  });

  test('resolves sibling ../lib helpers via clientRoots on scoped paths without emitting unrelated queries and rejects symlink targets', () => {
    const root = createTempProject();
    const outside = createTempProject();
    mkdirSync(join(root, 'src', 'lib'), { recursive: true });
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    mkdirSync(join(root, 'src', 'other'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'lib', 'refs.ts'),
      `
        import { getDatabase, ref } from 'firebase/database';
        export const db = getDatabase();
        export const teamMembers = (teamId: string) => ref(db, \`teams/\${teamId}/members\`);
      `,
    );
    writeFileSync(
      join(root, 'src', 'pages', 'roster.ts'),
      `
        import { get, orderByChild, query } from 'firebase/database';
        import { teamMembers } from '../lib/refs';
        export const loadRoster = (teamId: string) =>
          get(query(teamMembers(teamId), orderByChild('joinedAt')));
      `,
    );
    writeFileSync(
      join(root, 'src', 'other', 'unused.ts'),
      `
        import { get, getDatabase, orderByChild, query, ref } from 'firebase/database';
        const db = getDatabase();
        export const unused = () => get(query(ref(db, 'other/items'), orderByChild('rank')));
      `,
    );
    writeFileSync(join(outside, 'secret.ts'), 'export const x = 1;');
    symlinkSync(join(outside, 'secret.ts'), join(root, 'src', 'pages', 'leak.ts'));

    const scoped = extractRtdbIndexesFromPaths({
      projectDir: root,
      paths: ['src/pages'],
    });
    expect(scoped.warnings).toEqual([]);
    expect(scoped.requirements.map((r) => ({ path: r.path, indexOn: r.indexOn }))).toEqual([
      { path: 'teams/$teamId/members', indexOn: ['joinedAt'] },
    ]);

    expect(() =>
      extractRtdbIndexesFromPaths({
        projectDir: root,
        paths: ['src/pages/leak.ts'],
      }),
    ).toThrow(/symbolic link/i);
  });
});
