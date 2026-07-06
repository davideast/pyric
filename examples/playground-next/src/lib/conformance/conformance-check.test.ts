/**
 * SF-S4 wiring tests for the traffic-conformance check.
 *
 * The pure diff itself is covered by `traffic-conformance.test.ts`; these
 * pin the WIRING this track adds:
 *   - the gate scoring entry point (`scoreConformance`) — the metric Wave
 *     2's matrix reads (pass/fail, rate, counts);
 *   - the ambient summary projector (`summarizeConformance`) — the compact,
 *     capped report-don't-block payload;
 *   - the runtime adapters (`readAppSpecFromVfs`, `runtimeConformance`)
 *     with injected deps (no sandbox / no OPFS).
 *
 * The headline gate is the FALSE-POSITIVE bar: a valid app using
 * indeterminate (crossDoc / custom) conditions must NOT be flagged.
 */
import { describe, expect, it } from 'bun:test';
import type { AppSpecV1 } from '../agent/spec/schema';
import {
  readAppSpecFromVfs,
  runtimeConformance,
  scoreConformance,
  summarizeConformance,
} from './conformance-check';
import { checkTrafficConformance, type RecordedOp } from './traffic-conformance';

// A small matrix: path-uid notes + ownerField orders carrying a crossDoc +
// custom residue (the indeterminate path), plus a claim-gated collection.
const spec: AppSpecV1 = {
  meta: { title: 'fixture', assumptions: [] },
  identities: [{ uid: 'alice' }, { uid: 'bob' }, { uid: 'admin', claims: { role: 'admin' } }],
  collections: [
    {
      path: 'users/{uid}/notes/{noteId}',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'body', type: 'string' },
      ],
    },
    {
      path: 'orders/{orderId}',
      ownerField: 'userId',
      fields: [
        { name: 'userId', type: 'string', required: true },
        { name: 'itemId', type: 'string', required: true },
        { name: 'price', type: 'integer', required: true },
        { name: 'kind', type: 'string' },
      ],
    },
    { path: 'reports/{reportId}', fields: [{ name: 'value', type: 'integer' }] },
    {
      // remote collection referenced by the orders crossDoc condition;
      // declared so the spec passes referential validation.
      path: 'menuItems/{itemId}',
      fields: [{ name: 'price', type: 'integer', required: true }],
    },
  ],
  access: [
    { collection: 'users/{uid}/notes/{noteId}', op: 'get', grant: [{ kind: 'owner' }] },
    { collection: 'users/{uid}/notes/{noteId}', op: 'list', grant: [{ kind: 'owner' }] },
    {
      collection: 'users/{uid}/notes/{noteId}',
      op: 'create',
      grant: [{ kind: 'owner' }, { kind: 'requiredFields', fields: ['title'] }],
    },
    {
      collection: 'orders/{orderId}',
      op: 'create',
      grant: [
        { kind: 'authenticated' },
        { kind: 'owner' },
        { kind: 'requiredFields', fields: ['userId', 'itemId', 'price'] },
        { kind: 'fieldEquals', field: 'kind', value: 'standard' },
        {
          kind: 'crossDoc',
          collection: 'menuItems',
          docIdFrom: 'itemId',
          remoteField: 'price',
          localField: 'price',
        },
        {
          kind: 'custom',
          rulesExpr: 'request.time < resource.data.deadline',
          rationale: 'before deadline',
        },
      ],
    },
    { collection: 'reports/{reportId}', op: 'get', grant: [{ kind: 'claim', name: 'role', equals: 'admin' }] },
  ],
};

function op(o: Partial<RecordedOp> & Pick<RecordedOp, 'method' | 'path' | 'auth'>): RecordedOp {
  return o;
}
const as = (uid: string) => ({ uid });

// ─────────────────────────────────────────────────────────────────────
// Gate scoring entry point
// ─────────────────────────────────────────────────────────────────────

describe('scoreConformance — gate metric', () => {
  it('passes a conformant app (rate 1, zero violations)', () => {
    const traffic: RecordedOp[] = [
      op({ method: 'get', path: 'users/alice/notes/n1', auth: as('alice') }),
      op({
        method: 'create',
        path: 'users/alice/notes/n2',
        auth: as('alice'),
        request: { resourceData: { title: 'hi' } },
      }),
    ];
    const score = scoreConformance(spec, traffic);
    expect(score.pass).toBe(true);
    expect(score.violations).toBe(0);
    expect(score.conformant).toBe(2);
    expect(score.opsChecked).toBe(2);
    expect(score.conformanceRate).toBe(1);
  });

  it('fails an off-contract app and reports the rate', () => {
    const traffic: RecordedOp[] = [
      op({ method: 'get', path: 'users/alice/notes/n1', auth: as('alice') }), // ok
      op({ method: 'get', path: 'users/bob/notes/n1', auth: as('alice') }), // violation
    ];
    const score = scoreConformance(spec, traffic);
    expect(score.pass).toBe(false);
    expect(score.violations).toBe(1);
    expect(score.conformant).toBe(1);
    expect(score.conformanceRate).toBe(0.5);
  });

  it('counts uncovered ops separately (not held against the rate)', () => {
    const traffic: RecordedOp[] = [
      op({ method: 'get', path: 'users/alice/notes/n1', auth: as('alice') }), // ok
      op({ method: 'get', path: 'widgets/w1', auth: as('alice') }), // uncovered
    ];
    const score = scoreConformance(spec, traffic);
    expect(score.pass).toBe(true);
    expect(score.uncovered).toBe(1);
    expect(score.conformanceRate).toBe(1); // only the covered op counts
  });

  it('an empty traffic log passes vacuously (rate 1)', () => {
    const score = scoreConformance(spec, []);
    expect(score.pass).toBe(true);
    expect(score.opsChecked).toBe(0);
    expect(score.conformanceRate).toBe(1);
  });

  // THE HEADLINE GATE: near-zero false positives. A valid order whose only
  // unmet checks are indeterminate (crossDoc + custom) must NOT be flagged.
  it('FALSE-POSITIVE GUARD: a valid app using crossDoc/custom is NOT flagged', () => {
    const traffic: RecordedOp[] = [
      op({
        method: 'create',
        path: 'orders/o1',
        auth: as('bob'),
        // price intentionally mismatched vs a (non-existent) remote doc; the
        // crossDoc + custom conditions are indeterminate → never a deny.
        request: { resourceData: { userId: 'bob', itemId: 'm1', price: 999, kind: 'standard' } },
      }),
    ];
    const score = scoreConformance(spec, traffic);
    expect(score.pass).toBe(true);
    expect(score.violations).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Ambient summary projector
// ─────────────────────────────────────────────────────────────────────

describe('summarizeConformance — ambient payload', () => {
  it('returns null when no ops were checked (no recorded traffic)', () => {
    const report = checkTrafficConformance(spec, []);
    expect(summarizeConformance(report)).toBeNull();
  });

  it('returns a clean summary (violations 0) when traffic is on-contract', () => {
    const report = checkTrafficConformance(spec, [
      op({ method: 'get', path: 'users/alice/notes/n1', auth: as('alice') }),
    ]);
    const summary = summarizeConformance(report)!;
    expect(summary.violations).toBe(0);
    expect(summary.conformant).toBe(1);
    expect(summary.findings).toHaveLength(0);
  });

  it('surfaces the worst few violations as compact findings', () => {
    const report = checkTrafficConformance(spec, [
      op({ method: 'get', path: 'users/bob/notes/n1', auth: as('alice') }),
    ]);
    const summary = summarizeConformance(report)!;
    expect(summary.violations).toBe(1);
    const f = summary.findings[0]!;
    expect(f.path).toBe('users/bob/notes/n1');
    expect(f.method).toBe('get');
    expect(f.identity).toBe('alice');
    expect(f.rule).toContain('users/{uid}/notes/{noteId}');
    expect(f.reason.length).toBeGreaterThan(0);
  });

  it('caps findings at 5 while violations carries the true count', () => {
    const traffic: RecordedOp[] = [];
    for (let i = 0; i < 8; i++) {
      traffic.push(op({ method: 'get', path: `users/bob/notes/n${i}`, auth: as('alice') }));
    }
    const report = checkTrafficConformance(spec, traffic);
    const summary = summarizeConformance(report)!;
    expect(summary.violations).toBe(8);
    expect(summary.findings).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Runtime adapters (injected deps — no OPFS / no sandbox)
// ─────────────────────────────────────────────────────────────────────

describe('readAppSpecFromVfs', () => {
  const readOk = async () => JSON.stringify(spec);

  it('parses a valid spec', async () => {
    const parsed = await readAppSpecFromVfs(readOk);
    expect(parsed?.collections.length).toBe(4);
  });

  it('returns null on missing file', async () => {
    expect(await readAppSpecFromVfs(async () => null)).toBeNull();
  });

  it('returns null on empty/whitespace content', async () => {
    expect(await readAppSpecFromVfs(async () => '   ')).toBeNull();
  });

  it('returns null on unparseable JSON', async () => {
    expect(await readAppSpecFromVfs(async () => '{ not json')).toBeNull();
  });

  it('returns null on a structurally invalid spec (no error thrown)', async () => {
    expect(await readAppSpecFromVfs(async () => JSON.stringify({ meta: {} }))).toBeNull();
  });

  it('returns null when the reader throws (best-effort)', async () => {
    expect(
      await readAppSpecFromVfs(async () => {
        throw new Error('vfs boom');
      }),
    ).toBeNull();
  });
});

describe('runtimeConformance — VFS + traffic glue', () => {
  const readSpec = async () => JSON.stringify(spec);

  it('returns null when there is no recorded traffic (the availability subtlety)', async () => {
    const summary = await runtimeConformance({ readFile: readSpec, traffic: [] });
    expect(summary).toBeNull();
  });

  it('returns null when no spec exists (best-effort overlay)', async () => {
    const summary = await runtimeConformance({
      readFile: async () => null,
      traffic: [op({ method: 'get', path: 'users/alice/notes/n1', auth: as('alice') })],
    });
    expect(summary).toBeNull();
  });

  it('flags an off-contract app when spec + traffic both exist', async () => {
    const summary = await runtimeConformance({
      readFile: readSpec,
      traffic: [op({ method: 'get', path: 'users/bob/notes/n1', auth: as('alice') })],
    });
    expect(summary?.violations).toBe(1);
    expect(summary?.findings[0]!.path).toBe('users/bob/notes/n1');
  });

  it('reports clean for a conformant app', async () => {
    const summary = await runtimeConformance({
      readFile: readSpec,
      traffic: [op({ method: 'get', path: 'users/alice/notes/n1', auth: as('alice') })],
    });
    expect(summary?.violations).toBe(0);
  });

  it('FALSE-POSITIVE GUARD: a valid crossDoc/custom app is not flagged via the glue', async () => {
    const summary = await runtimeConformance({
      readFile: readSpec,
      traffic: [
        op({
          method: 'create',
          path: 'orders/o1',
          auth: as('bob'),
          request: { resourceData: { userId: 'bob', itemId: 'm1', price: 999, kind: 'standard' } },
        }),
      ],
    });
    expect(summary?.violations).toBe(0);
  });
});
