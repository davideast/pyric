import { describe, expect, test } from 'bun:test';
import {
  containsCallerSymbol,
  evalHandleFactory,
  extractStringHeader,
  splitHeaderAlternatives,
} from '../../../src/assurance-surface/code/resource-headers.js';
import { alternatives, lit, literalText, union, type AVal } from '../../../src/assurance-surface/code/values.js';
import { harness } from './harness.js';

describe('resource-headers', () => {
  test('extractStringHeader strips concrete headers and degrades dynamic template holes in headers', () => {
    const concrete = extractStringHeader(
      'firestore',
      'doc',
      [
        { kind: 'lit', text: '/databases/tenant-a/documents/items/' },
        { kind: 'hole', name: 'id', auth: [] },
      ],
      '(default)',
      false,
    );
    expect(concrete.resourceId).toBe('tenant-a');
    expect(concrete.note).toBeUndefined();

    const dynamic = extractStringHeader(
      'rtdb',
      'refFromURL',
      [
        { kind: 'lit', text: 'https://' },
        { kind: 'hole', name: 'shard', auth: [] },
        { kind: 'lit', text: '.firebaseio.com/items/1' },
      ],
      '(default)',
      true,
    );
    expect(dynamic.resourceId).toBe('(default)');
    expect(dynamic.note).toBe('resource header of refFromURL() was not literal');
    expect(literalText(dynamic.value)).toBe('items/1');

    const storageDownloadUrl = extractStringHeader(
      'storage',
      'refFromURL',
      [
        {
          kind: 'lit',
          text: 'https://firebasestorage.googleapis.com/v0/b/media-bucket/o/files%2F',
        },
        { kind: 'hole', name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
        { kind: 'lit', text: '%2Freport.pdf?alt=media&token=' },
        { kind: 'hole', name: 'downloadToken', auth: [] },
      ],
      '(default)',
      true,
    );
    expect(storageDownloadUrl.resourceId).toBe('media-bucket');
    expect(storageDownloadUrl.note).toBeUndefined();
    expect(storageDownloadUrl.value).toEqual({
      k: 'str',
      parts: [
        { kind: 'lit', text: 'files/' },
        { kind: 'hole', name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
        { kind: 'lit', text: '/report.pdf' },
      ],
    });
  });

  test('splitHeaderAlternatives keeps clean and dynamic-header branches separate', () => {
    const combined = union([
      lit('items/1'),
      {
        k: 'str',
        parts: [
          { kind: 'lit', text: '/databases/' },
          { kind: 'hole', name: 'tenant', auth: [] },
          { kind: 'lit', text: '/documents/items/2' },
        ],
      },
    ]);
    const alts = splitHeaderAlternatives('firestore', 'doc', combined, '(default)', (v) => v, false);
    expect(alts).toHaveLength(2);
    expect(alts.some((a) => a.resourceId === '(default)' && a.note === undefined)).toBe(true);
    expect(
      alts.some(
        (a) =>
          a.resourceId === '(default)' && a.note === 'resource header of doc() was not literal',
      ),
    ).toBe(true);
  });

  test('evalHandleFactory supports single-arg string unions and marks dynamic template strings', () => {
    const h = harness({
      'handles.ts': `
        import { getFirestore } from 'firebase/firestore';
        import { getDatabase } from 'firebase/database';
        declare const useArchive: boolean;
        declare const shard: string;
        export const unionFs = getFirestore((useArchive ? 'archive-db' : 'live-db') as any);
        export const templateDb = getDatabase(\`https://\${shard}.firebaseio.com\` as any);
      `,
    });
    const unionCall = h.expr('handles.ts', "getFirestore((useArchive ? 'archive-db' : 'live-db') as any)");
    if (!('arguments' in unionCall)) throw new Error('expected CallExpression');
    const fsVal = evalHandleFactory(
      h.ev,
      'firestore',
      'getFirestore',
      { resourceArgIndex: 1, singleStringArgIsResource: true },
      unionCall as any,
      (i) => h.ev.eval((unionCall as any).arguments[i]),
    );
    const fsAlts = alternatives(fsVal);
    expect(fsAlts.map((a) => (a.k === 'db' ? a.resourceId : null))).toEqual(['archive-db', 'live-db']);

    const tplVal = h.ev.force(h.ev.eval(h.ident('handles.ts', 'templateDb', 0)));
    expect(tplVal).toEqual({
      k: 'db',
      service: 'rtdb',
      resourceId: '(default)',
      notes: ['resource argument of getDatabase() was not literal'],
    });
  });

  test('containsCallerSymbol detects direct and union-wrapped parameter symbols', () => {
    const symVal: AVal = {
      k: 'sym',
      name: 'db',
      node: {} as any,
      resolve: () => lit('x'),
    };
    expect(containsCallerSymbol(symVal)).toBe(true);
    expect(containsCallerSymbol({ k: 'union', alts: [lit('a'), symVal] })).toBe(true);
    expect(containsCallerSymbol(lit('a'))).toBe(false);
  });
});
