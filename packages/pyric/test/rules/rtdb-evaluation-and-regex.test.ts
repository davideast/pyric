import { describe, expect, it } from 'bun:test';
import {
  all,
  expr,
  firestoreRules,
  rtdbRules,
  rtdbStdlib,
  type FirestoreCase,
} from 'pyric/rules';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules, seedDocuments } from 'pyric/sandbox/firestore';
import { doc, getDoc, getFirestore } from 'pyric/firestore';

describe('RTDB rules multi-path update precedence', () => {
  it('returns DENY instead of UNSUPPORTED when a sibling path has a confirmed .write denial', () => {
    const ruleset = rtdbRules({
      rules: {
        orgs: {
          alpha: {
            '.write': 'unknownHelper()',
          },
          beta: {
            '.write': 'auth.uid == "owner"',
          },
        },
      },
    });

    const summary = ruleset.simulate([
      {
        description: 'confirmed sibling deny overrides unsupported earlier write rule',
        expectation: 'DENY',
        operation: 'update',
        path: '/',
        auth: { uid: 'alice' },
        newData: {
          'orgs/alpha/status': 'active',
          'orgs/beta/status': 'active',
        },
      },
    ]);

    expect(summary.unsupported).toBe(0);
    expect(summary.passed).toBe(1);
    expect(summary.cases[0]!.decision).toBe('DENY');
    expect(summary.cases[0]!.unsupported).toBe(false);
  });

  it('returns DENY instead of UNSUPPORTED when a sibling path has a confirmed .validate denial across both key orders', () => {
    const ruleset = rtdbRules({
      rules: {
        orgs: {
          alpha: {
            '.write': 'unknownHelper()',
          },
          beta: {
            '.write': true,
            score: {
              '.validate': 'newData.isNumber()',
            },
          },
        },
      },
    });

    const summary = ruleset.simulate([
      {
        description: 'confirmed sibling .validate deny overrides earlier unsupported .write',
        expectation: 'DENY',
        operation: 'update',
        path: '/',
        auth: { uid: 'alice' },
        newData: {
          'orgs/alpha/status': 'active',
          'orgs/beta/score': 'not-a-number',
        },
      },
      {
        description: 'earlier confirmed .validate deny overrides later unsupported .write',
        expectation: 'DENY',
        operation: 'update',
        path: '/',
        auth: { uid: 'alice' },
        newData: {
          'orgs/beta/score': 'not-a-number',
          'orgs/alpha/status': 'active',
        },
      },
    ]);

    expect(summary.unsupported).toBe(0);
    expect(summary.passed).toBe(2);
    expect(summary.cases.map((c) => ({ decision: c.decision, unsupported: c.unsupported }))).toEqual([
      { decision: 'DENY', unsupported: false },
      { decision: 'DENY', unsupported: false },
    ]);
  });
});

describe('Firestore auth.tenant normalization parity', () => {
  it('projects top-level auth.tenant into request.auth.token.firebase.tenant while preserving explicit nested tenant overrides', async () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId} {
      allow read: if request.auth != null
        && request.auth.token.firebase.tenant == orgId;
    }
    match /items/{itemId} {
      allow list: if request.auth != null
        && resource.data.tenant == request.auth.token.firebase.tenant;
    }
  }
}`;

    const ruleset = firestoreRules(source);
    const cases: FirestoreCase[] = [
      {
        description: 'tenant-scoped get via top-level auth.tenant',
        expectation: 'ALLOW',
        method: 'get',
        path: 'orgs/org-1',
        auth: { uid: 'alice', tenant: 'org-1' },
        resource: { name: 'Org One' },
      },
      {
        description: 'explicit nested token.firebase.tenant overrides top-level auth.tenant',
        expectation: 'ALLOW',
        method: 'get',
        path: 'orgs/org-2',
        auth: {
          uid: 'alice',
          tenant: 'org-1',
          token: { firebase: { tenant: 'org-2' } },
        },
        resource: { name: 'Org Two' },
      },
      {
        description: 'list query proof normalizes top-level auth.tenant',
        expectation: 'ALLOW',
        method: 'list',
        path: 'items',
        auth: { uid: 'alice', tenant: 'org-1' },
        query: { where: [{ field: 'tenant', op: '==', value: 'org-1' }] },
      },
    ];

    const summary = ruleset.simulate(cases);
    expect(summary.cases.map((c) => c.decision)).toEqual(['ALLOW', 'ALLOW', 'ALLOW']);

    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, source);
    seedDocuments(sandbox, { 'orgs/org-1': { name: 'Org One' } });
    const db = getFirestore(sandbox.withAuth({ uid: 'alice', tenant: 'org-1' }));
    const snap = await getDoc(doc(db, 'orgs/org-1'));
    expect(snap.exists()).toBe(true);
  });
});

describe('RTDB regex character classes with leading closing bracket', () => {
  it('evaluates positive and negated character classes starting with ] and containing / or =', () => {
    const ruleset = rtdbRules({
      rules: {
        items: {
          positive: {
            '.write': true,
            '.validate': 'newData.isString() && newData.val().matches(/^[]/=]+$/)',
          },
          negated: {
            '.write': true,
            '.validate': 'newData.isString() && newData.val().matches(/^[^]/]+$/)',
          },
          deepParensInClass: {
            '.write': true,
            '.validate': `newData.isString() && newData.val().matches(/^[]/${'('.repeat(130)}]+$/)`,
          },
        },
      },
    });

    const summary = ruleset.simulate([
      {
        description: 'positive class allows ] / =',
        expectation: 'ALLOW',
        operation: 'write',
        path: '/items/positive',
        newData: ']//=',
      },
      {
        description: 'positive class rejects letters',
        expectation: 'DENY',
        operation: 'write',
        path: '/items/positive',
        newData: 'abc',
      },
      {
        description: 'negated class allows letters',
        expectation: 'ALLOW',
        operation: 'write',
        path: '/items/negated',
        newData: 'abc',
      },
      {
        description: 'negated class rejects ]',
        expectation: 'DENY',
        operation: 'write',
        path: '/items/negated',
        newData: 'a]b',
      },
      {
        description: 'negated class rejects /',
        expectation: 'DENY',
        operation: 'write',
        path: '/items/negated',
        newData: 'a/b',
      },
      {
        description: 'character class with leading ] and / keeps deep literal ( inside regex scan',
        expectation: 'ALLOW',
        operation: 'write',
        path: '/items/deepParensInClass',
        newData: ']/(',
      },
    ]);

    expect(summary.unsupported).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(6);
  });

  it('supports leading ] character classes in rtdbStdlib.validation.matches and all() composition', () => {
    expect(String(rtdbStdlib.validation.matches('^[]/]+$'))).toBe(
      'newData.isString() && newData.val().matches(/^[]/]+$/)',
    );
    expect(String(rtdbStdlib.validation.matches('^[^]/]+$'))).toBe(
      'newData.isString() && newData.val().matches(/^[^]/]+$/)',
    );
    expect(
      String(all(expr('newData.val().matches(/^[]/||]+$/)'), expr('auth != null'))),
    ).toBe('newData.val().matches(/^[]/||]+$/) && auth != null');
  });
});

describe('RTDB DataSnapshot .value/.priority wrappers and array child projection', () => {
  it('unwraps { .value, .priority } in child lookups and increment writes while hiding .value and array.length', () => {
    const ruleset = rtdbRules({
      rules: {
        items: {
          '.read':
            "data.child('title').val() == 'hello' && data.getPriority() == 10 && data.hasChild('.priority') && !data.child('.value').exists()",
          '.write': true,
          count: {
            '.validate': 'newData.val() == 7 && newData.parent().getPriority() == 10',
          },
        },
        leaf: {
          '.read': "!data.child('.value').exists() && data.hasChild('.priority') && data.val() == 'plain'",
        },
        list: {
          '.read': "!data.child('length').exists() && !data.hasChild('.priority') && data.child('0').val() == 'x' && data.child('1').val() == 'y'",
          '.write': true,
          '.validate': "newData.child('0').val() == 'x' && !newData.child('length').exists()",
        },
      },
    });

    const mockData = {
      items: {
        '.value': { title: 'hello', count: 5 },
        '.priority': 10,
      },
      leaf: {
        '.value': 'plain',
        '.priority': 99,
      },
      list: ['x', 'y'],
    };

    const summary = ruleset.simulate([
      {
        description: 'reads child through .value wrapper, preserves hasChild(.priority), and hides .value',
        expectation: 'ALLOW',
        operation: 'read',
        path: '/items',
        data: mockData,
      },
      {
        description: 'increments nested child under .value wrapper and preserves parent priority',
        expectation: 'ALLOW',
        operation: 'write',
        path: '/items/count',
        data: mockData,
        newData: { '.sv': { increment: 2 } },
      },
      {
        description: 'hides .value while preserving hasChild(.priority) on prioritized primitive leaf',
        expectation: 'ALLOW',
        operation: 'read',
        path: '/leaf',
        data: mockData,
      },
      {
        description: 'hides array.length from DataSnapshot.child on reads',
        expectation: 'ALLOW',
        operation: 'read',
        path: '/list',
        data: mockData,
      },
      {
        description: 'preserves sibling array elements on indexed child write',
        expectation: 'ALLOW',
        operation: 'write',
        path: '/list/1',
        data: mockData,
        newData: 'z',
      },
    ]);

    expect(summary.cases.map((c) => ({ desc: c.description, decision: c.decision }))).toEqual([
      { desc: 'reads child through .value wrapper, preserves hasChild(.priority), and hides .value', decision: 'ALLOW' },
      { desc: 'increments nested child under .value wrapper and preserves parent priority', decision: 'ALLOW' },
      { desc: 'hides .value while preserving hasChild(.priority) on prioritized primitive leaf', decision: 'ALLOW' },
      { desc: 'hides array.length from DataSnapshot.child on reads', decision: 'ALLOW' },
      { desc: 'preserves sibling array elements on indexed child write', decision: 'ALLOW' },
    ]);
  });
});

describe('RTDB simulate() update with trailing /.priority paths', () => {
  it('evaluates trailing /.priority update keys against the target node without matching $wildcard children', () => {
    const ruleset = rtdbRules({
      rules: {
        items: {
          a: {
            '.write': 'auth != null',
            '.validate':
              'newData.isString() && (newData.getPriority() == null || newData.getPriority() >= 0)',
            $other: {
              '.write': false,
              '.validate': false,
            },
          },
          b: {
            '.write': false,
            $other: {
              '.write': true,
            },
          },
        },
      },
    });

    const data = {
      items: {
        a: { '.value': 'hello', '.priority': 5 },
        b: 'locked',
      },
    };

    const summary = ruleset.simulate([
      {
        description: 'sets positive priority on primitive leaf',
        expectation: 'ALLOW',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data,
        newData: { 'a/.priority': 20 },
      },
      {
        description: 'clears priority on primitive leaf with null',
        expectation: 'ALLOW',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data,
        newData: { 'a/.priority': null },
      },
      {
        description: 'rejects priority failing target node .validate',
        expectation: 'DENY',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data,
        newData: { 'a/.priority': -1 },
      },
      {
        description: 'does not match $wildcard child .write rule for /.priority',
        expectation: 'DENY',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data,
        newData: { 'b/.priority': 20 },
      },
    ]);

    expect(summary.cases.map((c) => c.decision)).toEqual(['ALLOW', 'ALLOW', 'DENY', 'DENY']);
    expect(summary.passed).toBe(4);
  });

  it('produces identical post-write tree projections across update key orders for /.priority, sibling deletions, and auto-trimmed nodes', () => {
    const requirePriority20 = rtdbRules({
      rules: {
        items: {
          $id: {
            '.write': 'auth != null',
            '.validate': 'newData.getPriority() == 20',
          },
        },
      },
    });

    const newNodeSim = requirePriority20.simulate([
      {
        description: 'child write before /.priority on new node',
        expectation: 'ALLOW',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data: {},
        newData: { 'a/title': 'hello', 'a/.priority': 20 },
      },
      {
        description: '/.priority before child write on new node',
        expectation: 'ALLOW',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data: {},
        newData: { 'a/.priority': 20, 'a/title': 'hello' },
      },
      {
        description: 'sibling delete before sibling add preserves existing priority 20',
        expectation: 'ALLOW',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data: { items: { a: { old: 1, '.priority': 20 } } },
        newData: { 'a/old': null, 'a/title': 'hello' },
      },
      {
        description: 'inline .value/.priority wrapper works in either key order',
        expectation: 'ALLOW',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data: {},
        newData: { 'a': { '.value': 'x', '.priority': 20 }, 'b': { '.value': 'y', '.priority': 20 } },
      },
    ]);
    expect(newNodeSim.cases.map((c) => c.decision)).toEqual(['ALLOW', 'ALLOW', 'ALLOW', 'ALLOW']);

    const forbidNegativePriority = rtdbRules({
      rules: {
        items: {
          $id: {
            '.write': 'auth != null',
            '.validate': 'newData.getPriority() == null || newData.getPriority() >= 0',
          },
        },
        audits: {
          '.write': "!newData.parent().child('items/trimmed').exists()",
        },
      },
    });

    const edgeSim = forbidNegativePriority.simulate([
      {
        description: 'rejects negative /.priority listed before child creation on new node',
        expectation: 'DENY',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data: {},
        newData: { 'a/.priority': -999, 'a/title': 'hello' },
      },
      {
        description: 'rejects sibling swap when existing node retains negative priority regardless of delete-first order',
        expectation: 'DENY',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data: { items: { a: { old: 1, '.priority': -999 } } },
        newData: { 'a/old': null, 'a/title': 'hello' },
      },
      {
        description: 'clears negative /.priority on existing prioritized node regardless of key order (priority first)',
        expectation: 'ALLOW',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data: { items: { a: { old: 1, '.priority': -999 } } },
        newData: { 'a/.priority': null, 'a/old': null, 'a/title': 'hello' },
      },
      {
        description: 'clears negative /.priority on existing prioritized node regardless of key order (priority last)',
        expectation: 'ALLOW',
        operation: 'update',
        path: '/items',
        auth: { uid: 'alice' },
        data: { items: { a: { old: 1, '.priority': -999 } } },
        newData: { 'a/old': null, 'a/title': 'hello', 'a/.priority': null },
      },
      {
        description: 'auto-trims node and drops /.priority when last child is deleted in either order (delete first)',
        expectation: 'ALLOW',
        operation: 'update',
        path: '/',
        auth: { uid: 'alice' },
        data: { items: { trimmed: { only: 1, '.priority': 5 } } },
        newData: { 'items/trimmed/only': null, 'items/trimmed/.priority': 20, audits: 'ok' },
      },
      {
        description: 'auto-trims node and drops /.priority when last child is deleted in either order (priority first)',
        expectation: 'ALLOW',
        operation: 'update',
        path: '/',
        auth: { uid: 'alice' },
        data: { items: { trimmed: { only: 1, '.priority': 5 } } },
        newData: { 'items/trimmed/.priority': 20, 'items/trimmed/only': null, audits: 'ok' },
      },
    ]);
    expect(edgeSim.cases.map((c) => c.decision)).toEqual([
      'DENY',
      'DENY',
      'ALLOW',
      'ALLOW',
      'ALLOW',
      'ALLOW',
    ]);
  });
});



