import { describe, expect, test } from 'bun:test';
import { renderPath } from '../../../../src/assurance-surface/code/paths.js';
import { RTDB_SERVICE_MODEL } from '../../../../src/assurance-surface/code/service-models/rtdb.js';
import { alternatives, type AVal } from '../../../../src/assurance-surface/code/values.js';
import { harness } from '../harness.js';

function refSummary(v: AVal): { summary: string; resourceId?: string; vars?: unknown }[] {
  return alternatives(v).map((a) => {
    if (a.k !== 'ref') return { summary: a.k };
    const { path, variables } = renderPath(a.service, a.segments);
    return {
      summary: `${a.service}[${a.resourceId}]:${a.refKind}:${path}`,
      resourceId: a.resourceId,
      vars: variables,
    };
  });
}

describe('RTDB_SERVICE_MODEL', () => {
  test('declares RTDB modules, handle factories, ref constructors, constraints, and onDisconnect methods', () => {
    expect(RTDB_SERVICE_MODEL.service).toBe('rtdb');
    expect(RTDB_SERVICE_MODEL.modules).toContain('firebase/database');
    expect(RTDB_SERVICE_MODEL.modules).toContain('pyric/database');
    expect(RTDB_SERVICE_MODEL.modules).toContain('firebase-admin/database');
    expect(RTDB_SERVICE_MODEL.modules).toContain('pyric-admin/database');
    expect(RTDB_SERVICE_MODEL.handleFactories.getDatabaseWithUrl).toEqual({ resourceArgIndex: 0 });
    expect(RTDB_SERVICE_MODEL.handleFactories.getAdminDatabase).toEqual({
      resourceArgIndex: 1,
      singleStringArgIsResource: true,
    });
    expect(RTDB_SERVICE_MODEL.refConstructors.refFromURL).toBeDefined();
    expect(RTDB_SERVICE_MODEL.receiverMethods?.onDisconnect?.remove?.op).toBe('onDisconnect.remove');
  });

  test('extracts RTDB instance resourceId from getDatabase URLs and refFromURL', () => {
    const h = harness({
      'rtdb.ts': `
        import { getDatabase, ref, child, refFromURL } from 'pyric/database';
        import { getAuth } from 'pyric/auth';
        declare const app: unknown;
        const uid = getAuth().currentUser!.uid;
        const primary = getDatabase(app);
        const secondary = getDatabase(app, 'https://secondary-rtdb.firebaseio.com');
        const shorthand = getDatabase('https://metrics-rtdb.europe-west1.firebasedatabase.app');
        child(ref(primary, 'users'), uid);
        ref(secondary, 'sessions/' + uid);
        ref(shorthand, 'counters/daily');
        refFromURL(primary, 'https://secondary-rtdb.firebaseio.com/users/' + uid);
        refFromURL('https://secondary-rtdb.firebaseio.com/users/' + uid);
      `,
    });
    const at = (expr: string): AVal => h.ev.eval(h.expr('rtdb.ts', expr));
    expect(refSummary(at("child(ref(primary, 'users'), uid)"))[0]?.summary).toBe(
      'rtdb[(default)]:node:users/$uid',
    );
    expect(refSummary(at("ref(secondary, 'sessions/' + uid)"))[0]?.summary).toBe(
      'rtdb[secondary-rtdb]:node:sessions/$uid',
    );
    expect(refSummary(at("ref(shorthand, 'counters/daily')"))[0]?.summary).toBe(
      'rtdb[metrics-rtdb]:node:counters/daily',
    );

    const twoArgUrl = refSummary(at("refFromURL(primary, 'https://secondary-rtdb.firebaseio.com/users/' + uid)"))[0];
    expect(twoArgUrl).toEqual({
      summary: 'rtdb[secondary-rtdb]:node:users/$uid',
      resourceId: 'secondary-rtdb',
      vars: [{ name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] }],
    });

    const oneArgUrl = refSummary(at("refFromURL('https://secondary-rtdb.firebaseio.com/users/' + uid)"))[0];
    expect(oneArgUrl).toEqual({
      summary: 'rtdb[secondary-rtdb]:node:users/$uid',
      resourceId: 'secondary-rtdb',
      vars: [{ name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] }],
    });
  });

  test('resolves getDatabaseWithUrl, getAdminDatabase, and ServerValue.increment from admin RTDB modules', () => {
    const h = harness({
      'admin-rtdb.ts': `
        import { getDatabaseWithUrl, ServerValue } from 'firebase-admin/database';
        import { getAdminDatabase } from 'pyric-admin/database';
        import { ref } from 'pyric/database';
        declare const app: unknown;
        const urlDb = getDatabaseWithUrl('https://billing-rtdb.firebaseio.com', app as any);
        const adminDb = getAdminDatabase(app as any, 'https://audit-rtdb.firebaseio.com');
        export const billingNode = ref(urlDb as any, 'invoices/1');
        export const auditNode = ref(adminDb as any, 'events/1');
        export const bump = ServerValue.increment(1);
      `,
    });
    expect(refSummary(h.ev.eval(h.ident('admin-rtdb.ts', 'billingNode', 0)))[0]?.summary).toBe(
      'rtdb[billing-rtdb]:node:invoices/1',
    );
    expect(refSummary(h.ev.eval(h.ident('admin-rtdb.ts', 'auditNode', 0)))[0]?.summary).toBe(
      'rtdb[audit-rtdb]:node:events/1',
    );
    expect(h.ev.force(h.ev.eval(h.ident('admin-rtdb.ts', 'bump', 0)))).toEqual({
      k: 'fieldValue',
      name: 'increment',
    });
  });
});
