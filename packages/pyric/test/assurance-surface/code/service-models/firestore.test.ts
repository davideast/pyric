import { describe, expect, test } from 'bun:test';
import { renderPath } from '../../../../src/assurance-surface/code/paths.js';
import { FIRESTORE_SERVICE_MODEL } from '../../../../src/assurance-surface/code/service-models/firestore.js';
import { alternatives, type AVal } from '../../../../src/assurance-surface/code/values.js';
import { harness } from '../harness.js';

function refSummary(v: AVal): string[] {
  return alternatives(v).map((a) => {
    if (a.k !== 'ref') return a.k;
    const { path } = renderPath(a.service, a.segments);
    return `${a.service}[${a.resourceId}]:${a.refKind}:${path}`;
  });
}

describe('FIRESTORE_SERVICE_MODEL', () => {
  test('declares Firestore modules, handle factories, ref constructors, constraints, and receiver methods', () => {
    expect(FIRESTORE_SERVICE_MODEL.service).toBe('firestore');
    expect(FIRESTORE_SERVICE_MODEL.modules).toContain('firebase/firestore');
    expect(FIRESTORE_SERVICE_MODEL.modules).toContain('firebase/firestore/lite');
    expect(FIRESTORE_SERVICE_MODEL.modules).toContain('pyric/firestore');
    expect(FIRESTORE_SERVICE_MODEL.modules).toContain('firebase-admin/firestore');
    expect(FIRESTORE_SERVICE_MODEL.modules).toContain('pyric-admin/firestore');
    expect(FIRESTORE_SERVICE_MODEL.handleFactories.getAdminFirestore).toEqual({
      resourceArgIndex: 1,
      singleStringArgIsResource: true,
    });
    expect(FIRESTORE_SERVICE_MODEL.queryBuilder).toBe('query');
    expect(FIRESTORE_SERVICE_MODEL.receiverMethods?.batch?.set?.op).toBe('setDoc');
    expect(FIRESTORE_SERVICE_MODEL.receiverMethods?.transaction?.get?.op).toBe('get');
  });

  test('extracts named database resourceId from getFirestore and initializeFirestore', () => {
    const h = harness({
      'fs.ts': `
        import { getFirestore, initializeFirestore, collection, doc, collectionGroup } from 'pyric/firestore';
        declare const app: unknown;
        const defaultDb = getFirestore(app);
        const namedDb = getFirestore(app, 'analytics-db');
        const shorthandDb = getFirestore('reporting-db');
        const initDb = initializeFirestore(app, {}, 'audit-db');
        doc(defaultDb, 'orgs', 'o1');
        doc(collection(namedDb, 'events'), 'e1');
        collection(shorthandDb, 'metrics');
        collectionGroup(initDb, 'entries');
      `,
    });
    const at = (expr: string): AVal => h.ev.eval(h.expr('fs.ts', expr));
    expect(refSummary(at("doc(defaultDb, 'orgs', 'o1')"))).toEqual([
      'firestore[(default)]:doc:orgs/o1',
    ]);
    expect(refSummary(at("doc(collection(namedDb, 'events'), 'e1')"))).toEqual([
      'firestore[analytics-db]:doc:events/e1',
    ]);
    expect(refSummary(at("collection(shorthandDb, 'metrics')"))).toEqual([
      'firestore[reporting-db]:collection:metrics',
    ]);
    expect(refSummary(at("collectionGroup(initDb, 'entries')"))).toEqual([
      'firestore[audit-db]:collectionGroup:{path=**}/entries',
    ]);
  });

  test('resolves admin Firestore handles, FieldPath.documentId(), and static FieldValue sentinels', () => {
    const h = harness({
      'admin-fs.ts': `
        import { getFirestore, FieldPath, FieldValue } from 'firebase-admin/firestore';
        import { getAdminFirestore, collection, doc, query, where } from 'pyric-admin/firestore';
        declare const app: unknown;
        const adminDb = getFirestore(app as any, 'ops-db');
        const directAdminDb = getAdminFirestore(app as any, 'audit-db');
        export const adminDoc = doc(adminDb as any, 'orgs', 'o1');
        export const auditQuery = query(
          collection(directAdminDb as any, 'items'),
          where(FieldPath.documentId(), 'in', ['x', 'y']),
        );
        export const stamp = FieldValue.serverTimestamp();
        export const del = FieldValue.delete();
      `,
    });
    expect(refSummary(h.ev.eval(h.ident('admin-fs.ts', 'adminDoc', 0)))).toEqual([
      'firestore[ops-db]:doc:orgs/o1',
    ]);
    const qVal = h.ev.force(h.ev.eval(h.ident('admin-fs.ts', 'auditQuery', 0)));
    expect(qVal.k).toBe('ref');
    if (qVal.k === 'ref') {
      expect(qVal.resourceId).toBe('audit-db');
      expect(qVal.constraints).toEqual([
        {
          kind: 'where',
          field: '__name__',
          op: 'in',
          operand: {
            kind: 'array',
            items: [
              { kind: 'literal', literal: 'x' },
              { kind: 'literal', literal: 'y' },
            ],
          },
        },
      ]);
    }
    expect(h.ev.force(h.ev.eval(h.ident('admin-fs.ts', 'stamp', 0)))).toEqual({
      k: 'fieldValue',
      name: 'serverTimestamp',
    });
    expect(h.ev.force(h.ev.eval(h.ident('admin-fs.ts', 'del', 0)))).toEqual({
      k: 'fieldValue',
      name: 'deleteField',
    });
  });
});
