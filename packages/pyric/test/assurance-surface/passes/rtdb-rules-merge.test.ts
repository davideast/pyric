import { describe, expect, test } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { rtdbIndexPass } from '../../../src/assurance-surface/passes/rtdb-indexes.js';
import { checkRtdbIndexes } from '../../../src/assurance-surface/passes/rtdb-rules-check.js';
import { mergeRtdbIndexes } from '../../../src/assurance-surface/passes/rtdb-rules-merge.js';
import { compileRtdbRules } from '../../../src/rules/rtdb/compiled-rules.js';

function collectAllStructuralFindings(
  node: ReturnType<typeof compileRtdbRules>,
): NonNullable<ReturnType<typeof compileRtdbRules>['structure']> {
  const out = [...(node.structure ?? [])];
  for (const child of node.children) {
    out.push(...collectAllStructuralFindings(child));
  }
  return out;
}

describe('mergeRtdbIndexes', () => {
  test('merges .indexOn without clobbering .read/.write/.validate, reuses existing $wildcard, and propagates into literal siblings', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/queries.ts': `
          import { get, orderByChild, orderByValue, query, ref } from 'firebase/database';
          declare const db: unknown;

          export function runQueries(orgId: string) {
            return Promise.all([
              get(query(ref(db, \`orgs/\${orgId}/members\`), orderByChild('role'))),
              get(query(ref(db, \`orgs/\${orgId}/members\`), orderByChild('joinedAt'))),
              get(query(ref(db, 'scores/weekly'), orderByValue())),
            ]);
          }
        `,
      },
    });

    const pass = rtdbIndexPass(usage);
    const existingRules = `{
      // Existing security rules with comments and trailing commas
      "rules": {
        "orgs": {
          "$existingOrg": {
            ".read": "auth != null",
            "members": {
              ".write": "auth.uid === $existingOrg",
              ".validate": "newData.hasChildren(['role'])",
              ".indexOn": "email",
            }
          },
          "pinned": {
            ".read": true,
          }
        }
      }
    }`;

    const merged = mergeRtdbIndexes(existingRules, pass.requirements);
    expect(merged.changed).toBe(true);
    expect(merged.addedCount).toBe(5);

    const compiled = compileRtdbRules(merged.rules);
    expect(collectAllStructuralFindings(compiled)).toEqual([]);

    const rulesRoot = merged.rules.rules as Record<string, unknown>;
    const orgs = rulesRoot.orgs as Record<string, unknown>;
    expect(Object.keys(orgs).sort()).toEqual(['$existingOrg', 'pinned']);
    const wildcardMembers = (orgs.$existingOrg as Record<string, unknown>).members as Record<
      string,
      unknown
    >;
    expect(wildcardMembers['.write']).toBe('auth.uid === $existingOrg');
    expect(wildcardMembers['.validate']).toBe("newData.hasChildren(['role'])");
    expect(wildcardMembers['.indexOn']).toEqual(['email', 'joinedAt', 'role']);

    const pinned = orgs.pinned as Record<string, unknown>;
    expect(pinned['.read']).toBe(true);
    expect((pinned.members as Record<string, unknown>)['.indexOn']).toEqual(['joinedAt', 'role']);

    const scoresWeekly = (rulesRoot.scores as Record<string, unknown>).weekly as Record<
      string,
      unknown
    >;
    expect(scoresWeekly['.indexOn']).toBe('.value');

    expect(checkRtdbIndexes(merged.json, pass.requirements)).toEqual([]);

    const idempotent = mergeRtdbIndexes(merged.json, pass.requirements);
    expect(idempotent.changed).toBe(false);
    expect(idempotent.addedCount).toBe(0);
  });

  test('avoids self-induced shadowing and remains idempotent when mixing wildcard and concrete queries in any order', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/mixed.ts': `
          import { get, orderByChild, query, ref } from 'firebase/database';
          declare const db: unknown;

          export function byWildcard(orgId: string) {
            return get(query(ref(db, \`orgs/\${orgId}/members\`), orderByChild('role')));
          }

          export function byConcrete() {
            return get(query(ref(db, 'orgs/acme/members'), orderByChild('joinedAt')));
          }

          export function byUnderscoreLiteral() {
            return get(query(ref(db, 'orgs/_system/members'), orderByChild('priority')));
          }
        `,
      },
    });

    const pass = rtdbIndexPass(usage);
    const merged = mergeRtdbIndexes(undefined, pass.requirements);
    expect(merged.changed).toBe(true);
    expect(checkRtdbIndexes(merged.json, pass.requirements)).toEqual([]);

    const second = mergeRtdbIndexes(merged.json, pass.requirements);
    expect(second.changed).toBe(false);
    expect(second.addedCount).toBe(0);

    // Also test when concrete literal already exists on disk alongside wildcard query.
    const withPreexistingLiteral = mergeRtdbIndexes(
      { rules: { orgs: { acme: { '.read': true } } } },
      [...pass.requirements].reverse(),
    );
    expect(checkRtdbIndexes(withPreexistingLiteral.json, pass.requirements)).toEqual([]);
    const secondPreexisting = mergeRtdbIndexes(
      withPreexistingLiteral.json,
      [...pass.requirements].reverse(),
    );
    expect(secondPreexisting.changed).toBe(false);
    expect(secondPreexisting.addedCount).toBe(0);
  });

  test('does not create a shadowing literal branch when existing rules already define a $wildcard sibling with other subpaths', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/concrete.ts': `
          import { get, orderByChild, query, ref } from 'firebase/database';
          import { get as get2 } from 'firebase/database';
          declare const db: unknown;

          export function acmeMembers() {
            return get(query(ref(db, 'orgs/acme/members'), orderByChild('joinedAt')));
          }

          export function orgAudit(orgId: string) {
            return get2(query(ref(db, \`orgs/\${orgId}/auditLogs\`), orderByChild('ts')));
          }
        `,
      },
    });

    const pass = rtdbIndexPass(usage);
    const existingRules = {
      rules: {
        orgs: {
          $orgId: {
            auditLogs: {
              '.read': 'auth != null',
              '.indexOn': ['ts'],
            },
          },
        },
      },
    };

    const onlyConcrete = pass.requirements.filter((r) => r.path === 'orgs/acme/members');
    const merged = mergeRtdbIndexes(existingRules, onlyConcrete);
    const orgs = (merged.rules.rules as Record<string, unknown>).orgs as Record<string, unknown>;
    expect(Object.hasOwn(orgs, 'acme')).toBe(false);
    expect(checkRtdbIndexes(merged.json, pass.requirements)).toEqual([]);
  });

  test('guards against prototype pollution keys and runs without globalThis.process', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Object.defineProperty(globalThis, 'process', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const usage = extractSdkUsage({
        root: '/app',
        files: {
          'src/safe.ts': `
            import { get, orderByChild, query, ref } from 'firebase/database';
            declare const db: unknown;
            export function safeQuery() {
              return get(query(ref(db, 'items'), orderByChild('createdAt')));
            }
          `,
        },
      });
      const pass = rtdbIndexPass(usage);
      const rawJson = '{"rules":{"__proto__":{"polluted":true},"items":{".read":true}}}';
      const merged = mergeRtdbIndexes(rawJson, pass.requirements);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.hasOwn(merged.rules.rules as object, '__proto__')).toBe(false);
      expect(checkRtdbIndexes(merged.rules, pass.requirements)).toEqual([]);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'process', saved);
    }
  });
});
