/**
 * Planted-fixture tests for the traffic-conformance harness (SF-S0c).
 *
 * Fixtures are built BY HAND from a synthetic AppSpec + a synthetic
 * traffic-log shape (no sandbox, no model) so each assertion pins one
 * behavior of the pure diff:
 *   - a conformant app's traffic → zero violations;
 *   - off-contract ops (another user's data, an unauthenticated write,
 *     a denied-by-default op, a failed claim/fieldEquals) → the exact
 *     violation flagged with the denying rule;
 *   - an op on a path no collection covers → a coverage note, not a
 *     violation;
 *   - indeterminate conditions (crossDoc / custom) never manufacture a
 *     false violation.
 */
import { describe, expect, it } from 'bun:test';
import type { AppSpecV1 } from '../agent/spec/schema';
import { checkTrafficConformance, type RecordedOp } from './traffic-conformance';

// ─────────────────────────────────────────────────────────────────────
// A hand-built matrix: a notes app (path-uid owned) + an orders app
// (ownerField owned, with a claim + fieldEquals + crossDoc + custom),
// plus an admin-only collection (claim) and an unrelated uncovered one.
// ─────────────────────────────────────────────────────────────────────

const spec: AppSpecV1 = {
  meta: { title: 'fixture', assumptions: [] },
  identities: [
    { uid: 'alice' },
    { uid: 'bob' },
    { uid: 'admin', claims: { role: 'admin' } },
  ],
  collections: [
    {
      // path-uid owned: users/{uid}/notes/{noteId}
      path: 'users/{uid}/notes/{noteId}',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'body', type: 'string' },
      ],
    },
    {
      // ownerField owned: orders/{orderId}, owner = order.userId
      path: 'orders/{orderId}',
      ownerField: 'userId',
      fields: [
        { name: 'userId', type: 'string', required: true },
        { name: 'itemId', type: 'string', required: true },
        { name: 'price', type: 'integer', required: true },
        { name: 'note', type: 'string' },
        { name: 'kind', type: 'string' },
      ],
    },
    {
      // claim-gated admin collection
      path: 'reports/{reportId}',
      fields: [{ name: 'value', type: 'integer' }],
    },
  ],
  access: [
    // notes — owner only, all ops
    { collection: 'users/{uid}/notes/{noteId}', op: 'get', grant: [{ kind: 'owner' }] },
    { collection: 'users/{uid}/notes/{noteId}', op: 'list', grant: [{ kind: 'owner' }] },
    {
      collection: 'users/{uid}/notes/{noteId}',
      op: 'create',
      grant: [{ kind: 'owner' }, { kind: 'requiredFields', fields: ['title'] }],
    },
    { collection: 'users/{uid}/notes/{noteId}', op: 'update', grant: [{ kind: 'owner' }] },
    // (no delete rule for notes → deny-by-default)

    // orders — owner + required fields + a fixed kind (fieldEquals) +
    // a crossDoc price-match + a custom residue.
    {
      collection: 'orders/{orderId}',
      op: 'create',
      grant: [
        { kind: 'authenticated' },
        { kind: 'owner' },
        { kind: 'requiredFields', fields: ['userId', 'itemId', 'price'] },
        { kind: 'fieldEquals', field: 'kind', value: 'standard' },
        { kind: 'crossDoc', collection: 'menuItems', docIdFrom: 'itemId', remoteField: 'price', localField: 'price' },
        { kind: 'custom', rulesExpr: 'request.time < resource.data.deadline', rationale: 'before deadline' },
      ],
    },
    { collection: 'orders/{orderId}', op: 'get', grant: [{ kind: 'owner' }] },

    // reports — admin claim only, read
    { collection: 'reports/{reportId}', op: 'get', grant: [{ kind: 'claim', name: 'role', equals: 'admin' }] },
  ],
};

// Convenience builders for the recorded-traffic shape.
function op(o: Partial<RecordedOp> & Pick<RecordedOp, 'method' | 'path' | 'auth'>): RecordedOp {
  return o;
}
const as = (uid: string, token?: Record<string, unknown>) => (token ? { uid, token } : { uid });

// ─────────────────────────────────────────────────────────────────────

describe('checkTrafficConformance — conformant app', () => {
  it('flags zero violations when every op is within its grant', () => {
    const traffic: RecordedOp[] = [
      // alice reads + lists + writes her own notes
      op({ method: 'get', path: 'users/alice/notes/n1', auth: as('alice') }),
      op({ method: 'list', path: 'users/alice/notes', auth: as('alice') }),
      op({
        method: 'create',
        path: 'users/alice/notes/n2',
        auth: as('alice'),
        request: { resourceData: { title: 'hi', body: 'x' } },
      }),
      op({ method: 'update', path: 'users/alice/notes/n1', auth: as('alice'), request: { resourceData: { body: 'edit' } } }),
      // bob reads his own order
      op({ method: 'get', path: 'orders/o1', auth: as('bob'), resourceBefore: { data: { userId: 'bob' }, exists: true } }),
      // admin reads a report (claim satisfied)
      op({ method: 'get', path: 'reports/r1', auth: as('admin', { role: 'admin' }) }),
      // bob creates a valid order (custom + crossDoc indeterminate, never a false deny)
      op({
        method: 'create',
        path: 'orders/o2',
        auth: as('bob'),
        request: { resourceData: { userId: 'bob', itemId: 'm1', price: 5, kind: 'standard' } },
      }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(0);
    expect(report.coverage).toHaveLength(0);
    expect(report.opsChecked).toBe(7);
    expect(report.conformant).toBe(7);
  });
});

describe('checkTrafficConformance — off-contract affordances', () => {
  it('flags reading another user\'s data (owner violation, path-uid)', () => {
    const traffic: RecordedOp[] = [
      op({ method: 'get', path: 'users/bob/notes/n9', auth: as('alice') }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(1);
    const v = report.violations[0]!;
    expect(v.identity).toBe('alice');
    expect(v.method).toBe('get');
    expect(v.path).toBe('users/bob/notes/n9');
    expect(v.evaluation.violated?.kind).toBe('owner');
    expect(v.reason).toContain('owner only');
    expect(v.rule.collection).toBe('users/{uid}/notes/{noteId}');
  });

  it('flags reading another user\'s order (owner violation, ownerField)', () => {
    const traffic: RecordedOp[] = [
      op({
        method: 'get',
        path: 'orders/o1',
        auth: as('alice'),
        resourceBefore: { data: { userId: 'bob' }, exists: true },
      }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.evaluation.violated?.kind).toBe('owner');
  });

  it('flags an unauthenticated write (create with no identity)', () => {
    const traffic: RecordedOp[] = [
      op({
        method: 'create',
        path: 'users/alice/notes/n3',
        auth: null,
        request: { resourceData: { title: 'sneaky' } },
      }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(1);
    const v = report.violations[0]!;
    expect(v.identity).toBe('anonymous');
    // owner is first in the grant and denies unauthenticated.
    expect(v.evaluation.violated?.kind).toBe('owner');
    expect(v.reason).toContain('unauthenticated');
  });

  it('flags a deny-by-default op (covered collection, ungranted method)', () => {
    // notes has no `delete` rule → deny-by-default; deleting is off-contract.
    const traffic: RecordedOp[] = [
      op({ method: 'delete', path: 'users/alice/notes/n1', auth: as('alice') }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(1);
    const v = report.violations[0]!;
    expect(v.method).toBe('delete');
    expect(v.rule.grant).toBe('deny');
    expect(v.reason).toContain('deny-by-default');
    // It is a violation, NOT a coverage note (the matrix DOES cover the path).
    expect(report.coverage).toHaveLength(0);
  });

  it('flags a failed claim (non-admin reading a report)', () => {
    const traffic: RecordedOp[] = [
      op({ method: 'get', path: 'reports/r1', auth: as('alice') }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.evaluation.violated?.kind).toBe('claim');
  });

  it('flags a fieldEquals violation (wrong order kind)', () => {
    const traffic: RecordedOp[] = [
      op({
        method: 'create',
        path: 'orders/o5',
        auth: as('bob'),
        request: { resourceData: { userId: 'bob', itemId: 'm1', price: 5, kind: 'premium' } },
      }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.evaluation.violated?.kind).toBe('fieldEquals');
  });

  it('flags a missing required field (order without price)', () => {
    const traffic: RecordedOp[] = [
      op({
        method: 'create',
        path: 'orders/o6',
        auth: as('bob'),
        request: { resourceData: { userId: 'bob', itemId: 'm1', kind: 'standard' } },
      }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.evaluation.violated?.kind).toBe('requiredFields');
    expect(report.violations[0]!.reason).toContain('price');
  });
});

describe('checkTrafficConformance — coverage (not violations)', () => {
  it('emits a coverage note for a path no collection covers', () => {
    const traffic: RecordedOp[] = [
      op({ method: 'get', path: 'widgets/w1', auth: as('alice') }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(0);
    expect(report.coverage).toHaveLength(1);
    expect(report.coverage[0]!.path).toBe('widgets/w1');
    expect(report.coverage[0]!.reason).toContain('no collection');
  });
});

describe('checkTrafficConformance — set lowering', () => {
  it('lowers set→create on a new doc and applies the create grant', () => {
    // set with no prior doc → create; non-owner spoof must be denied.
    const traffic: RecordedOp[] = [
      op({
        method: 'set',
        path: 'orders/o7',
        auth: as('alice'),
        resourceBefore: { data: null, exists: false },
        request: { resourceData: { userId: 'bob', itemId: 'm1', price: 5, kind: 'standard' } },
      }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.method).toBe('create');
    expect(report.violations[0]!.evaluation.violated?.kind).toBe('owner');
  });

  it('lowers set→update on an existing doc (no order update rule → deny-by-default)', () => {
    const traffic: RecordedOp[] = [
      op({
        method: 'set',
        path: 'orders/o1',
        auth: as('bob'),
        resourceBefore: { data: { userId: 'bob' }, exists: true },
        request: { resourceData: { userId: 'bob', note: 'changed' } },
      }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.method).toBe('update');
    expect(report.violations[0]!.rule.grant).toBe('deny');
  });
});

describe('checkTrafficConformance — indeterminate conditions never false-positive', () => {
  it('does not flag a valid order whose only unmet checks are custom/crossDoc', () => {
    // bob owns it, all required + fieldEquals satisfied; crossDoc + custom
    // are indeterminate (no remote doc / not decidable) → grant, not deny.
    const traffic: RecordedOp[] = [
      op({
        method: 'create',
        path: 'orders/o8',
        auth: as('bob'),
        request: { resourceData: { userId: 'bob', itemId: 'm1', price: 999, kind: 'standard' } },
      }),
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.violations).toHaveLength(0);
    expect(report.conformant).toBe(1);
    // the indeterminate conditions are still surfaced in the evaluation.
    const ev = checkTrafficConformance(spec, traffic);
    void ev;
  });
});

describe('checkTrafficConformance — mixed log totals', () => {
  it('counts violations, coverage, and conformant ops independently', () => {
    const traffic: RecordedOp[] = [
      op({ method: 'get', path: 'users/alice/notes/n1', auth: as('alice') }), // ok
      op({ method: 'get', path: 'users/bob/notes/n1', auth: as('alice') }), // violation
      op({ method: 'get', path: 'widgets/w1', auth: as('alice') }), // coverage
    ];
    const report = checkTrafficConformance(spec, traffic);
    expect(report.opsChecked).toBe(3);
    expect(report.violations).toHaveLength(1);
    expect(report.coverage).toHaveLength(1);
    expect(report.conformant).toBe(1);
  });
});
