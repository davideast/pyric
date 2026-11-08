import { describe, expect, test } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { rtdbIndexPass } from '../../../src/assurance-surface/passes/rtdb-indexes.js';

describe('rtdbIndexPass', () => {
  test('extracts orderByChild, nested slash paths, and orderByValue across wildcard paths, branches, and instances', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/rtdb-queries.ts': `
          import {
            equalTo,
            get,
            getDatabase,
            limitToFirst,
            limitToLast,
            onValue,
            orderByChild,
            orderByKey,
            orderByPriority,
            orderByValue,
            query,
            ref,
            refFromURL,
          } from 'firebase/database';

          const defaultDb = getDatabase();
          const shardDb = getDatabase(undefined, 'https://shard-01.firebaseio.com');

          export function loadOrgMembers(orgId: string, sortByScore: boolean) {
            const membersRef = ref(defaultDb, \`orgs/\${orgId}/members\`);
            const q = sortByScore
              ? query(membersRef, orderByChild('metrics/score'), limitToLast(10))
              : query(membersRef, orderByChild('role'), equalTo('admin'), limitToFirst(25));
            return get(q);
          }

          export function watchOrgJoined(tenantId: string, cb: (snap: unknown) => void) {
            return onValue(query(ref(defaultDb, 'orgs/' + tenantId + '/members'), orderByChild('joinedAt')), cb);
          }

          export function loadTopScores() {
            return get(query(ref(defaultDb, 'leaderboards/global'), orderByValue(), limitToLast(5)));
          }

          export function keyAndPriorityNeedNoIndexOn() {
            const k = query(ref(defaultDb, 'logs'), orderByKey(), limitToLast(20));
            const p = query(ref(defaultDb, 'legacy'), orderByPriority());
            return Promise.all([get(k), get(p)]);
          }

          export function loadShardEvents() {
            return get(query(ref(shardDb, 'queues/jobs'), orderByChild('priority')));
          }

          export function loadUrlEvents(roomId: string) {
            const urlRef = refFromURL(\`https://shard-02.firebaseio.com/rooms/\${roomId}/peers\`);
            return get(query(urlRef, orderByChild('lastSeen')));
          }
        `,
      },
    });

    const res = rtdbIndexPass(usage);
    expect(res.warnings).toEqual([]);
    expect(
      res.requirements.map((r) => ({
        resourceId: r.resourceId,
        path: r.path,
        indexOn: r.indexOn,
      })),
    ).toEqual([
      {
        resourceId: '(default)',
        path: 'leaderboards/global',
        indexOn: ['.value'],
      },
      {
        resourceId: '(default)',
        path: 'orgs/$orgId/members',
        indexOn: ['joinedAt', 'metrics/score', 'role'],
      },
      {
        resourceId: 'shard-01',
        path: 'queues/jobs',
        indexOn: ['priority'],
      },
      {
        resourceId: 'shard-02',
        path: 'rooms/$roomId/peers',
        indexOn: ['lastSeen'],
      },
    ]);

    const shardOnly = rtdbIndexPass(usage, { instance: 'https://Shard-01.firebaseio.com' });
    expect(shardOnly.requirements).toHaveLength(1);
    expect(shardOnly.requirements[0]?.path).toBe('queues/jobs');
    expect(shardOnly.requirements[0]?.indexOn).toEqual(['priority']);
  });

  test('emits unresolved-query and dynamic-order-field warnings with source line numbers', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/warnings.ts': `
          import { get, orderByChild, query, ref } from 'firebase/database';
          declare const db: unknown;
          declare function unknownRef(): unknown;

          export function unresolvedBase() {
            return get(query(unknownRef() as never, orderByChild('createdAt')));
          }

          export function dynamicField(sortKey: string) {
            return get(query(ref(db, 'items'), orderByChild(sortKey)));
          }
        `,
      },
    });

    const res = rtdbIndexPass(usage);
    expect(res.requirements).toEqual([]);
    expect(res.warnings.map((w) => ({ code: w.code, file: w.file, line: w.line }))).toEqual([
      { code: 'unresolved-query', file: 'src/warnings.ts', line: 7 },
      { code: 'dynamic-order-field', file: 'src/warnings.ts', line: 11 },
    ]);
  });
});
