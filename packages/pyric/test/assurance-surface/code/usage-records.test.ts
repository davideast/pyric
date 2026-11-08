import { describe, expect, test } from 'bun:test';
import { renderResourcePattern } from '../../../src/sandbox/internal/resource-pattern.js';
import { SiteCollector } from '../../../src/assurance-surface/code/sites.js';
import {
  constraintListKey,
  refIdentityKey,
  SITE_USAGE,
} from '../../../src/assurance-surface/code/usage-records.js';
import { harness, ROOT } from './harness.js';

describe('usage-records', () => {
  test('attaches plain-data ref and query records onto winning AccessSite instances and collects standalone constructions', () => {
    const h = harness({
      'items.ts': `
        import { getFirestore, collection, doc, query, where, getDocs } from 'pyric/firestore';
        const db = getFirestore();
        export const exportedDoc = doc(db, 'orgs', 'acme');
        export async function listItems(uid: string) {
          return getDocs(query(collection(db, 'items'), where('ownerId', '==', uid)));
        }
      `,
    });
    const collector = new SiteCollector(h.ev, ROOT, true);
    collector.scanFile(h.file('items.ts'), true);
    const result = collector.finish();

    expect(result.usage?.refs.some((r) => renderResourcePattern(r.pattern) === 'orgs/acme')).toBe(true);
    const readSite = collector.sites.find((s) => s.op === 'query' && s.resolution === 'resolved');
    expect(readSite).toBeDefined();
    const attached = SITE_USAGE.get(readSite!);
    expect(attached).toHaveLength(1);
    expect(attached![0]!.refRecord.consumer).toBe('query@items.ts:6');
    expect(attached![0]!.queryRecord?.consumer).toBe('query@items.ts:6');
    expect(refIdentityKey(attached![0]!.refRecord)).toContain('firestore|(default)|collection|items|');
    expect(constraintListKey(attached![0]!.queryRecord!.branchConstraints[0]!)).toContain('where:ownerId:==');
  });
});
