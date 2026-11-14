import { describe, expect, it } from 'bun:test';
import { parseToAST, SimulateFirestoreRulesHandler } from '@pyric/rules/internal';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { concretizeQueryTarget } from '../../../src/assurance-surface/passes/static-query-proof-args.js';
import { evaluateCandidateArm } from '../../../src/assurance-surface/passes/static-query-proof-eval.js';

describe('static-query-proof-witness', () => {
  it('synthesizes valid witnesses for not-in, open float/int intervals, and non-numeric range filters', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /statusDocs/{id} {
      allow list: if resource.data.meta.active == true
        && !(resource.data.status in ['archived', 'deleted']);
    }
    match /scoreDocs/{id} {
      allow list: if resource.data.score > 0 && resource.data.score < 1;
    }
    match /intDocs/{id} {
      allow list: if resource.data.count is int && resource.data.count > 0 && resource.data.count < 5;
    }
    match /slugDocs/{id} {
      allow list: if resource.data.slug > 'm' && resource.data.slug < 'n';
    }
    match /prefixDocs/{id} {
      allow list: if resource.data.slug < 'm';
    }
    match /timeDocs/{id} {
      allow list: if resource.data.at > timestamp.date(2026, 1, 1)
        && resource.data.at < timestamp.date(2026, 1, 2);
    }
    match /byteDocs/{id} {
      allow list: if resource.data.tag > b'\\x01' && resource.data.tag < b'\\x02';
    }
    match /multiArrayDocs/{id} {
      allow list: if 'alpha' in resource.data.meta.tags && 'beta' in resource.data.meta.tags;
    }
  }
}`;
    const ast = parseToAST(source)!;
    const simulator = new SimulateFirestoreRulesHandler();
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/ranges.ts': `
          import { Bytes, Timestamp, collection, getDocs, getFirestore, query, where } from 'firebase/firestore';
          const db = getFirestore();
          export async function run() {
            await getDocs(query(
              collection(db, 'statusDocs'),
              where('meta.active', '==', true),
              where('status', 'not-in', ['archived', 'deleted']),
            ));
            await getDocs(query(
              collection(db, 'scoreDocs'),
              where('score', '>', 0),
              where('score', '<', 1),
            ));
            await getDocs(query(
              collection(db, 'intDocs'),
              where('count', '>', 0),
              where('count', '<', 5),
            ));
            await getDocs(query(
              collection(db, 'slugDocs'),
              where('slug', '>', 'm'),
              where('slug', '<', 'n'),
            ));
            await getDocs(query(
              collection(db, 'prefixDocs'),
              where('slug', '<', 'm'),
            ));
            await getDocs(query(
              collection(db, 'timeDocs'),
              where('at', '>', Timestamp.fromMillis(1767225600000)),
              where('at', '<', Timestamp.fromMillis(1767312000000)),
            ));
            await getDocs(query(
              collection(db, 'byteDocs'),
              where('tag', '>', Bytes.fromUint8Array(new Uint8Array([1]))),
              where('tag', '<', Bytes.fromUint8Array(new Uint8Array([2]))),
            ));
            await getDocs(query(
              collection(db, 'multiArrayDocs'),
              where('meta.tags', 'array-contains', 'alpha'),
              where('meta.tags', 'array-contains', 'beta'),
            ));
          }
        `,
      },
    });

    expect(usage.queries.length).toBe(8);
    for (let i = 0; i < usage.queries.length; i += 1) {
      const q = usage.queries[i]!;
      const target = concretizeQueryTarget(q.baseRef)!;
      const failure = evaluateCandidateArm(
        simulator,
        { source, file: 'firestore.rules', ast },
        target,
        q.constraints,
      );
      expect(failure?.certainty, `query[${i}] (${target.collectionPath})`).toBe('heuristic');
    }
  });

  it('keeps genuinely unsatisfiable or rule-violating range queries at static-proof certainty', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /scoreDocs/{id} {
      allow list: if resource.data.score > 10;
    }
    match /emptySlugDocs/{id} {
      allow list: if resource.data.slug < '';
    }
  }
}`;
    const ast = parseToAST(source)!;
    const simulator = new SimulateFirestoreRulesHandler();
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/bad-ranges.ts': `
          import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';
          const db = getFirestore();
          export async function run() {
            await getDocs(query(collection(db, 'scoreDocs'), where('score', '>', 0), where('score', '<', 5)));
            await getDocs(query(collection(db, 'emptySlugDocs'), where('slug', '<', '')));
          }
        `,
      },
    });

    for (const q of usage.queries) {
      const target = concretizeQueryTarget(q.baseRef)!;
      const failure = evaluateCandidateArm(
        simulator,
        { source, file: 'firestore.rules', ast },
        target,
        q.constraints,
      );
      expect(failure?.certainty).toBe('static-proof');
    }
  });
});
