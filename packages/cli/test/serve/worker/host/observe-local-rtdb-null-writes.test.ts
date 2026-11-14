import { describe, expect, it } from 'bun:test';
import { getAdminDatabase, getDatabase, ref as dbRef, sandbox as dbSandbox, set as dbSet, update as dbUpdate } from 'pyric/database';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox, type ObservedCall } from 'pyric/sandbox';
import { createObservedSessionDataStore } from '../../../../src/serve/observed-session/store.js';
import type { HostCtx } from '../../../../src/serve/worker/host.js';
import { rtdbVerdict } from '../../../../src/serve/worker/host/observe-local-rtdb.js';
import { setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';

const INSTANCE = 'demo-project-default-rtdb';
const DENIED: ObservedCall['outcome'] = { status: 'error', code: 'permission_denied' };

const ANCESTOR_VALIDATE_RULES = {
  rules: {
    orgs: {
      $orgId: {
        '.validate': "newData.hasChildren(['name', 'active'])",
        active: {
          '.write': true,
        },
        items: {
          $itemId: {
            '.write': true,
          },
        },
        '.write': true,
      },
    },
  },
};

function makeHost(instanceId = 'rtdb-effective-null-test') {
  const sandbox = initializeSandbox();
  const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId,
    subs: new Map(),
    rtdbProjectId: 'demo-project',
    observedSession,
  };
  expect(setDatabaseRules(ctx, undefined, ANCESTOR_VALIDATE_RULES).ok).toBe(true);
  return { sandbox, ctx, observedSession };
}

describe('observe-local-rtdb effective-null write normalization', () => {
  it('abstains when set, setWithPriority, update, or push writes effective-null shapes under an uncaptured ancestor .validate', async () => {
    // Verify ground-truth Sandbox denies each effective-null write when sibling `name` exists on /orgs/org-1.
    const oracleSb = initializeSandbox();
    try {
      const adminDb = getAdminDatabase(oracleSb);
      await dbSet(dbRef(adminDb, '/'), {
        orgs: { 'org-1': { name: 'Alpha', active: { enabled: true } } },
      });
      dbSandbox.setRules(adminDb, ANCESTOR_VALIDATE_RULES);
      const clientDb = getDatabase(oracleSb.withAuth({ uid: 'u-1' }));

      await expect(dbSet(dbRef(clientDb, 'orgs/org-1/active'), {})).rejects.toThrow();
      await expect(dbSet(dbRef(clientDb, 'orgs/org-1/active'), [])).rejects.toThrow();
      await expect(dbSet(dbRef(clientDb, 'orgs/org-1/active'), { a: null, b: { c: null } })).rejects.toThrow();
      await expect(dbUpdate(dbRef(clientDb, 'orgs/org-1'), { active: [] })).rejects.toThrow();
    } finally {
      oracleSb.dispose();
    }

    const { sandbox, ctx } = makeHost();
    try {
      const effectiveNullPayloads: unknown[] = [
        null,
        {},
        [],
        [null, {}, []],
        { a: null, b: { c: null } },
        { '.value': null },
        { '.priority': 1 },
        { '.value': null, '.priority': 'high' },
      ];

      for (const [idx, writeData] of effectiveNullPayloads.entries()) {
        const setVerdict = rtdbVerdict(
          ctx,
          {
            service: 'rtdb',
            method: 'set',
            path: 'orgs/org-1/active',
            instance: INSTANCE,
            projectId: 'demo-project',
            account: { uid: 'u-1', claims: {} },
            writeData: writeData as ObservedCall['writeData'],
            at: 100 + idx,
            outcome: DENIED,
          },
          'set',
        );
        expect(setVerdict).toMatchObject({
          result: 'unevaluated',
          needs: ['stored-document'],
          missingPaths: ['/orgs/org-1'],
        });

        const updateVerdict = rtdbVerdict(
          ctx,
          {
            service: 'rtdb',
            method: 'update',
            path: 'orgs/org-1',
            instance: INSTANCE,
            projectId: 'demo-project',
            account: { uid: 'u-1', claims: {} },
            writeData: { active: writeData } as ObservedCall['writeData'],
            at: 200 + idx,
            outcome: DENIED,
          },
          'update',
        );
        expect(updateVerdict).toMatchObject({
          result: 'unevaluated',
          needs: ['stored-document'],
          missingPaths: ['/orgs/org-1'],
        });
      }

      const setWithPrioVerdict = rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'setWithPriority',
          path: 'orgs/org-1/active',
          instance: INSTANCE,
          projectId: 'demo-project',
          account: { uid: 'u-1', claims: {} },
          writeData: { '.priority': 5 },
          at: 300,
          outcome: DENIED,
        },
        'set',
      );
      expect(setWithPrioVerdict).toMatchObject({
        result: 'unevaluated',
        needs: ['stored-document'],
        missingPaths: ['/orgs/org-1'],
      });

      const pushEmptyVerdict = rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'push',
          path: 'orgs/org-1/items',
          instance: INSTANCE,
          projectId: 'demo-project',
          account: { uid: 'u-1', claims: {} },
          writeData: {},
          at: 301,
          outcome: DENIED,
        },
        'create',
      );
      expect(pushEmptyVerdict).toMatchObject({
        result: 'unevaluated',
        needs: ['stored-document'],
        missingPaths: ['/orgs/org-1'],
      });

      // Uncaptured writeData (undefined) still abstains with needs: ['write-data'], not stored-document removal.
      const uncapturedSet = rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: 'orgs/org-1',
          instance: INSTANCE,
          projectId: 'demo-project',
          account: { uid: 'u-1', claims: {} },
          at: 302,
          outcome: DENIED,
        },
        'set',
      );
      expect(uncapturedSet).toMatchObject({
        result: 'unevaluated',
        needs: ['write-data'],
      });
    } finally {
      sandbox.dispose();
    }
  });

  it('authoritatively denies effective-null set and update writes when the ancestor subtree is captured', () => {
    const { sandbox, ctx, observedSession } = makeHost('rtdb-effective-null-captured');
    try {
      observedSession.apply({
        rtdb: [
          {
            kind: 'set',
            instance: INSTANCE,
            path: '/orgs/org-1',
            value: { name: 'Alpha', active: { enabled: true } },
          },
        ],
      });

      expect(
        rtdbVerdict(
          ctx,
          {
            service: 'rtdb',
            method: 'set',
            path: 'orgs/org-1/active',
            instance: INSTANCE,
            projectId: 'demo-project',
            account: { uid: 'u-1', claims: {} },
            writeData: {},
            at: 400,
            outcome: DENIED,
          },
          'set',
        ),
      ).toMatchObject({ result: 'deny' });

      expect(
        rtdbVerdict(
          ctx,
          {
            service: 'rtdb',
            method: 'update',
            path: 'orgs/org-1',
            instance: INSTANCE,
            projectId: 'demo-project',
            account: { uid: 'u-1', claims: {} },
            writeData: { active: [] },
            at: 401,
            outcome: DENIED,
          },
          'update',
        ),
      ).toMatchObject({ result: 'deny' });
    } finally {
      sandbox.dispose();
    }
  });

  it('abstains when update or set writes a .priority path under an uncaptured ancestor .validate', async () => {
    const priorityRules = {
      rules: {
        orgs: {
          $orgId: {
            '.write': true,
            '.validate': "newData.hasChild('name')",
          },
        },
      },
    };
    const oracleSb = initializeSandbox();
    try {
      const adminDb = getAdminDatabase(oracleSb);
      await dbSet(dbRef(adminDb, '/'), { orgs: { 'org-1': { status: 'draft' } } });
      dbSandbox.setRules(adminDb, priorityRules);
      const clientDb = getDatabase(oracleSb.withAuth({ uid: 'u-1' }));
      await expect(dbUpdate(dbRef(clientDb, 'orgs/org-1'), { 'active/.priority': 5 })).rejects.toThrow();
    } finally {
      oracleSb.dispose();
    }

    const sandbox = initializeSandbox();
    const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'rtdb-priority-patch-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession,
    };
    expect(setDatabaseRules(ctx, undefined, priorityRules).ok).toBe(true);
    try {
      const updateVerdict = rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'update',
          instance: INSTANCE,
          path: 'orgs/org-1',
          at: 500,
          outcome: DENIED,
          account: { uid: 'u-1' },
          writeData: { 'active/.priority': 5 },
        },
        'update',
      );
      expect(updateVerdict).toMatchObject({
        result: 'unevaluated',
        needs: ['stored-document'],
        missingPaths: ['/orgs/org-1'],
      });

      const directPriorityVerdict = rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          instance: INSTANCE,
          path: 'orgs/org-1/active/.priority',
          at: 501,
          outcome: DENIED,
          account: { uid: 'u-1' },
          writeData: 5,
        },
        'set',
      );
      expect(directPriorityVerdict).toMatchObject({
        result: 'unevaluated',
        needs: ['stored-document'],
        missingPaths: ['/orgs/org-1'],
      });
    } finally {
      sandbox.dispose();
    }
  });
});
