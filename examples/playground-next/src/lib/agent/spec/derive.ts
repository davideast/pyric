/**
 * Pure derivers over AppSpecV1 (plans/app-spec.md §4) — the closed
 * algebra the whole feature stands on: enumerable inputs, round-trip
 * pinnable (derive.roundtrip.test.ts), no I/O.
 *
 * `deriveTests(spec)` returns the W1 runner's OWN types
 * (`WorkspaceTestFile[]` — §5: no parallel types). Enumeration policy,
 * per access-matrix cell (collection × op):
 *
 *   GRANTED cell (grant = Condition[]):
 *   - one satisfying ALLOW case (identity meeting every claim cond;
 *     owns the target doc; data satisfies every data cond, incl. a
 *     seeded crossDoc remote). SKIPPED when the grant contains a
 *     `custom` condition — custom derives nothing; the model supplies
 *     those cases and the count is surfaced.
 *   - anon DENY whenever any condition implies auth (authenticated /
 *     owner / claim).
 *   - per spec identity whose claims DON'T satisfy the cell's claim
 *     conds: an otherwise-satisfying DENY (own doc, good data) — the
 *     claim check is the only violation. If every spec identity holds
 *     the claim, a synthesized claimless identity probes instead.
 *   - owner violations (get/update/delete: another identity vs the
 *     owner's doc; create: payload claiming someone else's uid /
 *     another uid's path slot). On LIST, `owner` degrades to
 *     `authenticated` (rules can't read resource.data during list —
 *     the draft guidance itself mandates query-side filtering), so no
 *     non-owner list DENY is derived.
 *   - requiredFields → one DENY per missing field (CREATE only:
 *     update's merged-write semantics make "missing in payload" legal).
 *   - fieldImmutable → changed-field DENY (UPDATE only).
 *   - enumTransition → legal-transition ALLOW + illegal-transition DENY
 *     (UPDATE only; illegal case only when the enum has an illegal
 *     target to probe).
 *   - fieldEquals → wrong-value DENY (CREATE/UPDATE, and GET/DELETE where it
 *     is evaluable against resource.data — a read gated by a field value is a
 *     real filter, not a fail-open public read).
 *   - crossDoc → drift DENY (CREATE/UPDATE; the satisfying ALLOW is the
 *     match case, with the remote doc seeded).
 *
 *   UNGRANTED / 'deny' cell — the deny-by-default class models never
 *   write: anon + EVERY spec identity probe the op and must DENY. The
 *   probe doc is owned by the first spec identity so owner-shaped
 *   over-grants are caught too.
 *
 * Every derived case carries `source: 'derived'` (runner provenance:
 * spec-vs-rules disagreement — either may be wrong) and a name of the
 * form `spec: <collection> <op> — <what>` so failures map back to the
 * generating rule (`findRuleForCase`).
 */
import type { SeedUser } from 'pyric/auth';
import { FIRESTORE_METHODS, type FirestoreMethod, type TestIdentity } from 'pyric/rules';
import type { WorkspaceTestCase, WorkspaceTestFile } from '~/lib/workspace-tests/runner';
import {
  collectionPathOf,
  isWildcard,
  resolveCollection,
  type AccessRule,
  type AppSpecV1,
  type CollectionSpec,
  type Condition,
  type FieldSpec,
  type IdentitySpec,
} from './schema';

// ─────────────────────────────────────────────────────────────────────
// deriveIdentities — IdentitySpec → SeedUser (typed mapper, §5)
// ─────────────────────────────────────────────────────────────────────

/** Map the spec's identities onto pyric `SeedUser`s. Email/password are
 *  deterministic sandbox-only defaults when the spec omits them. */
export function deriveIdentities(spec: AppSpecV1): SeedUser[] {
  return spec.identities.map((id) => ({
    uid: id.uid,
    email: id.email ?? `${id.uid}@example.test`,
    password: `pw-${id.uid}`,
    ...(id.displayName ? { displayName: id.displayName } : {}),
    ...(id.claims && Object.keys(id.claims).length > 0 ? { customClaims: id.claims } : {}),
  }));
}

/** Runner case identity for a spec identity (claims ride as `token`). */
export function caseIdentity(id: IdentitySpec): TestIdentity {
  return {
    uid: id.uid,
    ...(id.claims && Object.keys(id.claims).length > 0 ? { token: id.claims } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// custom-condition surface (counted, never derived)
// ─────────────────────────────────────────────────────────────────────

export interface CustomConditionRef {
  collection: string;
  op: FirestoreMethod;
  rulesExpr: string;
  rationale: string;
}

/** Every `custom` condition in the matrix — the unverified residue the
 *  validation result surfaces (custom-condition rate observable). */
export function customConditions(spec: AppSpecV1): CustomConditionRef[] {
  const out: CustomConditionRef[] = [];
  for (const rule of spec.access) {
    if (rule.grant === 'deny') continue;
    for (const cond of rule.grant) {
      if (cond.kind === 'custom') {
        out.push({
          collection: rule.collection,
          op: rule.op,
          rulesExpr: cond.rulesExpr,
          rationale: cond.rationale,
        });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// condition / identity helpers
// ─────────────────────────────────────────────────────────────────────

type GrantConds = Extract<AccessRule['grant'], readonly Condition[]>;

function claimConds(conds: GrantConds) {
  return conds.filter((c): c is Extract<Condition, { kind: 'claim' }> => c.kind === 'claim');
}

function requiresAuth(conds: GrantConds): boolean {
  return conds.some((c) => c.kind === 'authenticated' || c.kind === 'owner' || c.kind === 'claim');
}

function hasOwner(conds: GrantConds): boolean {
  return conds.some((c) => c.kind === 'owner');
}

/** Does a condition contribute a predicate for `op`? Exact mirror of
 *  `conditionExpr` in compile-rules.ts (which conditions emit a non-null
 *  expression per op). Kept in lockstep so the deriver agrees with the
 *  compiler about which cells fail closed vs. produce an allow. */
function conditionYieldsPredicate(kind: Condition['kind'], op: FirestoreMethod): boolean {
  switch (kind) {
    case 'authenticated':
    case 'owner':
    case 'claim':
      return true;
    case 'fieldEquals':
      // Evaluable on writes (payload) and on get/delete (resource.data);
      // `list` has no single resource, so it yields nothing.
      return op !== 'list';
    case 'fieldImmutable':
    case 'enumTransition':
      return op === 'update';
    case 'requiredFields':
      return op === 'create';
    case 'crossDoc':
      return op === 'create' || op === 'update';
    case 'custom':
      return false;
  }
}

/** Does this grant compile to `allow <op>: if false;` (a full deny)? A
 *  non-empty, custom-free, auth-free grant whose every condition is
 *  inapplicable to `op` (e.g. a `list` gated only by a field-shaped
 *  condition) fails closed in the compiler — so the deriver must model the
 *  cell as DENIED (all identities denied), not derive a phantom public
 *  ALLOW. Mirrors compileOp's fail-closed branch. */
function grantCompilesToDeny(conds: GrantConds, op: FirestoreMethod): boolean {
  if (conds.length === 0) return false; // empty grant = public (if true)
  if (conds.some((c) => c.kind === 'custom')) return false; // hole path
  if (requiresAuth(conds)) return false; // floored at request.auth != null
  return !conds.some((c) => conditionYieldsPredicate(c.kind, op));
}

/** Structural value equality — the canonical comparison the matrix uses
 *  for claim/fieldEquals checks. Exported so the traffic-conformance
 *  harness (src/lib/conformance) decides equality identically to the
 *  test deriver, instead of duplicating the rule (§5 type-cohesion: one
 *  declaration, consumers in lockstep). */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function satisfiesClaims(id: IdentitySpec, conds: GrantConds): boolean {
  return claimConds(conds).every((c) => sameValue(id.claims?.[c.name], c.equals));
}

/** Token payload that satisfies a cell's claim conditions — for
 *  synthesized identities. */
function claimToken(conds: GrantConds): Record<string, unknown> | undefined {
  const cs = claimConds(conds);
  if (cs.length === 0) return undefined;
  const token: Record<string, unknown> = {};
  for (const c of cs) token[c.name] = c.equals;
  return token;
}

// ─────────────────────────────────────────────────────────────────────
// evaluateGrant — the matrix's GRANT decision over a CONCRETE op
// ─────────────────────────────────────────────────────────────────────
//
// The deriver above ENUMERATES test cases from a grant (the forward
// direction). The traffic-conformance harness (src/lib/conformance) asks
// the INVERSE: given an op an app actually performed, does the grant
// permit it for the acting identity? Both need the same condition
// semantics — claim equality, owner resolution, auth. Rather than
// duplicate them in the harness, the decision lives HERE, beside the
// primitives it shares (claimConds / sameValue), and is exported. (S4
// will reuse the same function when it turns the harness into a gate.)
//
// Conservative by construction: a condition the recorded evidence can't
// settle (crossDoc without the remote doc, enumTransition without the
// before-state's transition map, custom) is reported INDETERMINATE and
// never produces a denial — the harness must not flag a violation it
// cannot prove (the S4 near-zero-false-positive requirement). A grant
// DENIES only when some condition is *decidably* violated.

/** The recorded evidence a grant is evaluated against — the subset of a
 *  sandbox traffic op the condition algebra can read. All optional: the
 *  evaluator degrades to INDETERMINATE for conditions whose evidence is
 *  absent rather than guessing. */
export interface GrantEvidence {
  /** The acting identity (null = unauthenticated). */
  identity: { uid: string; token?: Record<string, unknown> } | null;
  /** The owner uid the op's target resolves to, when knowable — the
   *  final path-wildcard slot for path-uid collections, or the
   *  `ownerField` value (from payload on create, before-state otherwise)
   *  for ownerField collections. */
  ownerUid?: string | null;
  /** The write payload (create/update), for field-shaped conditions. */
  data?: Record<string, unknown> | null;
  /** The document state before the op, for immutability checks. */
  before?: Record<string, unknown> | null;
  /** Whether the target document existed before the op. */
  existedBefore?: boolean;
}

export type GrantDecision = 'grant' | 'deny';

/** Why a grant denied / could not be fully proven — one entry per
 *  condition that mattered. `decided` distinguishes a real violation
 *  from an unverifiable condition. */
export interface ConditionVerdict {
  kind: Condition['kind'];
  /** 'grant' = satisfied; 'deny' = decidably violated; 'indeterminate' =
   *  evidence insufficient (does NOT contribute to a denial). */
  outcome: 'grant' | 'deny' | 'indeterminate';
  detail: string;
}

export interface GrantEvaluation {
  decision: GrantDecision;
  /** Per-condition verdicts (in grant order). */
  verdicts: ConditionVerdict[];
  /** The first decidably-violated condition, when `decision === 'deny'`. */
  violated: ConditionVerdict | null;
}

/**
 * Decide whether `grant` permits an op described by `ev`. `'deny'`
 * grants always deny; an empty grant (`[]`, public) always grants. For a
 * condition list the grant holds iff NO condition is decidably violated —
 * indeterminate conditions are treated as "not a proof of denial".
 */
export function evaluateGrant(
  grant: AccessRule['grant'],
  ev: GrantEvidence,
): GrantEvaluation {
  if (grant === 'deny') {
    const v: ConditionVerdict = { kind: 'authenticated', outcome: 'deny', detail: 'op is deny-by-default (not granted)' };
    return { decision: 'deny', verdicts: [v], violated: v };
  }
  const verdicts: ConditionVerdict[] = [];
  for (const cond of grant) {
    verdicts.push(evaluateCondition(cond, ev));
  }
  const violated = verdicts.find((v) => v.outcome === 'deny') ?? null;
  return { decision: violated ? 'deny' : 'grant', verdicts, violated };
}

function evaluateCondition(cond: Condition, ev: GrantEvidence): ConditionVerdict {
  const grant = (detail: string): ConditionVerdict => ({ kind: cond.kind, outcome: 'grant', detail });
  const deny = (detail: string): ConditionVerdict => ({ kind: cond.kind, outcome: 'deny', detail });
  const unknown = (detail: string): ConditionVerdict => ({ kind: cond.kind, outcome: 'indeterminate', detail });

  switch (cond.kind) {
    case 'authenticated':
      return ev.identity ? grant('signed in') : deny('requires a signed-in user; op was unauthenticated');
    case 'owner': {
      if (!ev.identity) return deny('owner requires a signed-in user; op was unauthenticated');
      if (ev.ownerUid === undefined || ev.ownerUid === null) {
        return unknown('owner uid for the target could not be resolved from the op');
      }
      return ev.identity.uid === ev.ownerUid
        ? grant(`acting uid "${ev.identity.uid}" owns the target`)
        : deny(`owner only: "${ev.identity.uid}" acted on a doc owned by "${ev.ownerUid}"`);
    }
    case 'claim': {
      if (!ev.identity) return deny(`claim ${cond.name} requires a signed-in user`);
      const have = ev.identity.token?.[cond.name];
      return sameValue(have, cond.equals)
        ? grant(`claim ${cond.name} = ${JSON.stringify(cond.equals)}`)
        : deny(`claim ${cond.name} must equal ${JSON.stringify(cond.equals)}, was ${JSON.stringify(have)}`);
    }
    case 'fieldEquals': {
      if (!ev.data) return unknown(`no write payload to check ${cond.field}`);
      return sameValue(ev.data[cond.field], cond.value)
        ? grant(`${cond.field} = ${JSON.stringify(cond.value)}`)
        : deny(`${cond.field} must equal ${JSON.stringify(cond.value)}, was ${JSON.stringify(ev.data[cond.field])}`);
    }
    case 'requiredFields': {
      if (!ev.data) return unknown(`no write payload to check required fields`);
      const missing = cond.fields.filter((f) => !(f in ev.data!));
      return missing.length === 0
        ? grant(`all required fields present (${cond.fields.join(', ')})`)
        : deny(`missing required field(s): ${missing.join(', ')}`);
    }
    case 'fieldImmutable': {
      if (!ev.data || !(cond.field in ev.data)) return grant(`${cond.field} not in payload — unchanged`);
      if (!ev.before) return unknown(`no before-state to compare immutable ${cond.field}`);
      return sameValue(ev.data[cond.field], ev.before[cond.field])
        ? grant(`${cond.field} unchanged`)
        : deny(`${cond.field} is immutable but changed from ${JSON.stringify(ev.before[cond.field])} to ${JSON.stringify(ev.data[cond.field])}`);
    }
    // Conditions whose proof needs evidence the traffic op doesn't carry
    // (a remote doc, a full transition map, raw rules). Never a denial —
    // surfaced as indeterminate so the harness reports coverage, not a
    // false violation. S4 may tighten these with richer evidence.
    case 'crossDoc':
      return unknown(`crossDoc(${cond.collection}.${cond.remoteField}) needs the remote doc to decide`);
    case 'enumTransition':
      return unknown(`enumTransition(${cond.field}) needs the before-state transition map to decide`);
    case 'custom':
      return unknown(`custom condition — not mechanically decidable`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// value / data / path construction
// ─────────────────────────────────────────────────────────────────────

function sampleValue(f: FieldSpec): unknown {
  if (f.enum && f.enum.length > 0) return f.enum[0];
  switch (f.type) {
    case 'string':
      return `${f.name}-1`;
    case 'integer':
      return 1;
    case 'double':
      return 1.5;
    case 'boolean':
      return true;
    case 'timestamp':
      return '2026-01-01T00:00:00Z';
    case 'bytes':
      return '';
    case 'geopoint':
      return { latitude: 0, longitude: 0 };
    case 'reference':
      return `${f.name}/ref-1`;
    case 'array':
      return [];
    case 'map':
      return {};
  }
}

/** A value guaranteed ≠ the given one (drift / violation payloads). */
function differentValue(v: unknown): unknown {
  if (typeof v === 'number') return v + 1;
  if (typeof v === 'boolean') return !v;
  return `${typeof v === 'string' ? v : JSON.stringify(v)}-changed`;
}

interface TransitionPick {
  from: string;
  legal: string;
  /** An enum value NOT legal from `from` (and ≠ from) — null when the
   *  enum offers nothing illegal to probe. */
  illegal: string | null;
}

function pickTransition(f: FieldSpec): TransitionPick | null {
  const trans = f.transitions ?? {};
  const enumVals = (f.enum ?? []).map(String);
  for (const [from, nexts] of Object.entries(trans)) {
    if (nexts.length === 0) continue;
    const legal = nexts[0]!;
    const illegal = enumVals.find((v) => v !== from && !nexts.includes(v)) ?? null;
    return { from, legal, illegal };
  }
  return null;
}

interface CellCtx {
  spec: AppSpecV1;
  col: CollectionSpec;
  rule: AccessRule;
  conds: GrantConds;
  seed: Map<string, Record<string, unknown>>;
  cases: WorkspaceTestCase[];
  /** Allocates collection-unique doc ids so per-case seeds never collide. */
  nextId: () => string;
}

/** Instantiate the collection's path template as a DOCUMENT path.
 *  Intermediate wildcards take the owner's uid (the user-rooted-
 *  subcollection idiom); the final wildcard is `docId`. */
function docPath(col: CollectionSpec, docId: string, ownerUid: string): string {
  const segs = col.path.split('/').filter((s) => s.length > 0);
  const lastWild = segs.reduce((acc, s, i) => (isWildcard(s) ? i : acc), -1);
  const out = segs.map((s, i) => {
    if (!isWildcard(s)) return s;
    return i === lastWild ? docId : ownerUid;
  });
  if (lastWild === -1) out.push(docId); // template without a doc wildcard
  return out.join('/');
}

/** Collection path for `list` cases (intermediate wildcards → owner). */
function listPath(col: CollectionSpec, ownerUid: string): string {
  const segs = col.path.split('/').filter((s) => s.length > 0);
  if (segs.length > 0 && isWildcard(segs[segs.length - 1]!)) segs.pop();
  return segs.map((s) => (isWildcard(s) ? ownerUid : s)).join('/');
}

/** For path-uid-owned collections the doc id IS the owner's uid. */
function ownedDocId(col: CollectionSpec, ownerUid: string, fallbackId: string): string {
  return col.ownerField ? fallbackId : ownerUid;
}

/**
 * Build data satisfying every data-shaped condition: required fields,
 * fieldEquals values, ownerField = owner uid, crossDoc-consistent
 * local fields (seeding the remote doc), enum fields at a transition
 * start state. Returns null data fields for conditions that don't
 * apply. Mutates `ctx.seed` for crossDoc remotes.
 */
function satisfyingData(ctx: CellCtx, ownerUid: string): Record<string, unknown> {
  const { col, conds } = ctx;
  const data: Record<string, unknown> = {};
  const put = (name: string): void => {
    const f = col.fields.find((x) => x.name === name);
    if (f && !(name in data)) {
      const t = f.transitions ? pickTransition(f) : null;
      data[name] = t ? t.from : sampleValue(f);
    }
  };
  for (const f of col.fields) if (f.required) put(f.name);
  for (const cond of conds) {
    if (cond.kind === 'requiredFields') for (const f of cond.fields) put(f);
    if (cond.kind === 'fieldEquals') data[cond.field] = cond.value;
    if (cond.kind === 'fieldImmutable') put(cond.field);
    if (cond.kind === 'enumTransition') put(cond.field);
    if (cond.kind === 'crossDoc') {
      const remote = resolveCollection(ctx.spec, cond.collection);
      const remoteCol = remote ? collectionPathOf(remote.path) : cond.collection;
      const remoteId = `${remoteCol.replace(/\//g, '-')}-x1`;
      const remoteField = remote?.fields.find((f) => f.name === cond.remoteField);
      const remoteValue = remoteField ? sampleValue(remoteField) : 'x1';
      const remoteData: Record<string, unknown> = { [cond.remoteField]: remoteValue };
      if (remote) {
        for (const f of remote.fields) {
          if (f.required && !(f.name in remoteData)) remoteData[f.name] = sampleValue(f);
        }
      }
      ctx.seed.set(`${remoteCol}/${remoteId}`, remoteData);
      data[cond.docIdFrom] = remoteId;
      data[cond.localField] = remoteValue;
    }
  }
  if (col.ownerField) data[col.ownerField] = ownerUid;
  return data;
}

/** Minimal benign UPDATE payload that keeps every condition satisfied. */
function benignUpdate(ctx: CellCtx, base: Record<string, unknown>): Record<string, unknown> {
  const { col, conds } = ctx;
  for (const cond of conds) {
    if (cond.kind === 'enumTransition') {
      const f = col.fields.find((x) => x.name === cond.field);
      const t = f ? pickTransition(f) : null;
      if (t) return { [cond.field]: t.legal };
    }
  }
  const frozen = new Set<string>([col.ownerField ?? '']);
  for (const cond of conds) {
    if (cond.kind === 'fieldImmutable') frozen.add(cond.field);
    if (cond.kind === 'fieldEquals') frozen.add(cond.field);
    if (cond.kind === 'crossDoc') {
      frozen.add(cond.localField);
      frozen.add(cond.docIdFrom);
    }
    if (cond.kind === 'enumTransition') frozen.add(cond.field);
  }
  const mutable = col.fields.find((f) => !frozen.has(f.name) && !f.immutable && !f.transitions);
  if (mutable) return { [mutable.name]: differentValue(base[mutable.name] ?? sampleValue(mutable)) };
  // Nothing safely mutable — re-assert an existing value (a no-op write
  // is still a rules-visible update).
  const first = Object.keys(base)[0];
  return first ? { [first]: base[first] } : {};
}

// ─────────────────────────────────────────────────────────────────────
// per-cell derivation
// ─────────────────────────────────────────────────────────────────────

function pushCase(
  ctx: CellCtx,
  what: string,
  as: TestIdentity | null,
  doPart: WorkspaceTestCase['do'],
  expect: 'ALLOW' | 'DENY',
): void {
  ctx.cases.push({
    as,
    do: doPart,
    expect,
    source: 'derived',
    name: `spec: ${collectionPathOf(ctx.col.path)} ${ctx.rule.op} — ${what}`,
  });
}

function deriveGrantedCell(ctx: CellCtx): void {
  const { spec, col, conds } = ctx;
  const op = ctx.rule.op;
  const auth = requiresAuth(conds);
  const owned = hasOwner(conds);
  const customs = conds.filter((c) => c.kind === 'custom');

  const satisfier = spec.identities.find((id) => satisfiesClaims(id, conds)) ?? null;
  const owner = satisfier ?? spec.identities[0]!;
  const actor: TestIdentity | null = auth
    ? satisfier
      ? caseIdentity(satisfier)
      : { uid: 'spec-actor', ...(claimToken(conds) ? { token: claimToken(conds)! } : {}) }
    : null;
  const actorUid = actor?.uid ?? owner.uid;

  // A second identity for non-owner probes — must still satisfy claims
  // so ownership is the ONLY violation. Synthesized when no spec
  // identity fits.
  const other =
    spec.identities.find((id) => id.uid !== actorUid && satisfiesClaims(id, conds)) ?? null;
  const intruder: TestIdentity = other
    ? caseIdentity(other)
    : { uid: 'spec-intruder', ...(claimToken(conds) ? { token: claimToken(conds)! } : {}) };

  const deriveAllow = customs.length === 0;
  const pathUidOwned = owned && !col.ownerField;
  const baseId = ctx.nextId();
  const targetId = pathUidOwned ? actorUid : baseId;
  const target = docPath(col, targetId, actorUid);
  const baseData = satisfyingData(ctx, actorUid);

  if (op === 'get' || op === 'delete') {
    ctx.seed.set(target, baseData);
    if (deriveAllow) pushCase(ctx, 'granted identity allowed', actor, { method: op, path: target }, 'ALLOW');
    if (auth) pushCase(ctx, 'unauthenticated denied', null, { method: op, path: target }, 'DENY');
    if (owned) pushCase(ctx, `non-owner (${intruder.uid}) denied`, intruder, { method: op, path: target }, 'DENY');
    // fieldEquals is evaluable on get/delete (`resource.data.<field>`), so a
    // wrong-value doc must be DENIED — pins that the read predicate actually
    // filters (the fail-open guard). Seeded at a fresh doc so it never
    // clobbers the satisfying ALLOW doc above.
    // (Skip on path-uid collections: the doc id IS the owner uid, so a
    // second doc for the same actor would collide with the ALLOW doc above;
    // the owner predicate already yields a non-owner DENY there.)
    if (!pathUidOwned) {
      for (const cond of conds) {
        if (cond.kind === 'fieldEquals') {
          const wrongTarget = docPath(col, ctx.nextId(), actorUid);
          const wrongData = { ...baseData, [cond.field]: differentValue(cond.value) };
          ctx.seed.set(wrongTarget, wrongData);
          pushCase(ctx, `wrong "${cond.field}" value denied`, actor, { method: op, path: wrongTarget }, 'DENY');
        }
      }
    }
  }

  if (op === 'list') {
    ctx.seed.set(target, baseData);
    const path = listPath(col, actorUid);
    if (deriveAllow) pushCase(ctx, 'granted identity allowed', actor, { method: 'list', path }, 'ALLOW');
    if (auth) pushCase(ctx, 'unauthenticated denied', null, { method: 'list', path }, 'DENY');
    // owner on list degrades to authenticated — see module doc.
  }

  if (op === 'create') {
    // CREATE must hit a doc that does NOT exist (an existing doc turns
    // setDoc into an update at rules time). Other cells seed the spec
    // identities' path-uid slots, so create-class cases on path-uid
    // collections act as a FRESH self-owned identity (`<uid>-new`,
    // claims preserved) whose slot nothing seeds.
    const cActor: TestIdentity | null = pathUidOwned
      ? { uid: `${actorUid}-new`, ...(actor?.token ? { token: actor.token } : {}) }
      : actor;
    const cUid = cActor?.uid ?? actorUid;
    const cTarget = pathUidOwned ? docPath(col, cUid, cUid) : target;
    const cData = pathUidOwned ? satisfyingData(ctx, cUid) : baseData;
    const freshPath = () => (pathUidOwned ? cTarget : docPath(col, ctx.nextId(), cUid));
    if (deriveAllow) {
      pushCase(ctx, 'granted identity allowed', cActor, { method: 'create', path: cTarget, data: cData }, 'ALLOW');
    }
    if (auth) {
      pushCase(ctx, 'unauthenticated denied', null, { method: 'create', path: docPath(col, ctx.nextId(), cUid), data: cData }, 'DENY');
    }
    if (owned) {
      const victimUid = intruder.uid;
      if (pathUidOwned) {
        pushCase(ctx, `creating under someone else's id (${victimUid}-new) denied`, cActor, { method: 'create', path: docPath(col, `${victimUid}-new`, `${victimUid}-new`), data: cData }, 'DENY');
      } else if (col.ownerField) {
        const spoof = { ...cData, [col.ownerField]: victimUid };
        pushCase(ctx, `creating a doc owned by someone else (${victimUid}) denied`, cActor, { method: 'create', path: freshPath(), data: spoof }, 'DENY');
      }
    }
    for (const cond of conds) {
      if (cond.kind === 'requiredFields') {
        for (const field of cond.fields) {
          const partial = { ...cData };
          delete partial[field];
          pushCase(ctx, `missing required field "${field}" denied`, cActor, { method: 'create', path: freshPath(), data: partial }, 'DENY');
        }
      }
      if (cond.kind === 'fieldEquals') {
        const bad = { ...cData, [cond.field]: differentValue(cond.value) };
        pushCase(ctx, `wrong "${cond.field}" value denied`, cActor, { method: 'create', path: freshPath(), data: bad }, 'DENY');
      }
      if (cond.kind === 'crossDoc') {
        const drift = { ...cData, [cond.localField]: differentValue(cData[cond.localField]) };
        pushCase(ctx, `"${cond.localField}" drifting from ${cond.collection}.${cond.remoteField} denied`, cActor, { method: 'create', path: freshPath(), data: drift }, 'DENY');
      }
    }
  }

  if (op === 'update') {
    ctx.seed.set(target, baseData);
    const benign = benignUpdate(ctx, baseData);
    if (deriveAllow) pushCase(ctx, 'granted identity allowed', actor, { method: 'update', path: target, data: benign }, 'ALLOW');
    if (auth) pushCase(ctx, 'unauthenticated denied', null, { method: 'update', path: target, data: benign }, 'DENY');
    if (owned) pushCase(ctx, `non-owner (${intruder.uid}) denied`, intruder, { method: 'update', path: target, data: benign }, 'DENY');
    for (const cond of conds) {
      if (cond.kind === 'fieldImmutable') {
        const change = { [cond.field]: differentValue(baseData[cond.field]) };
        pushCase(ctx, `changing immutable "${cond.field}" denied`, actor, { method: 'update', path: target, data: change }, 'DENY');
      }
      if (cond.kind === 'enumTransition') {
        const f = col.fields.find((x) => x.name === cond.field);
        const t = f ? pickTransition(f) : null;
        if (t) {
          if (deriveAllow) {
            pushCase(ctx, `legal "${cond.field}" transition ${t.from}→${t.legal} allowed`, actor, { method: 'update', path: target, data: { [cond.field]: t.legal } }, 'ALLOW');
          }
          if (t.illegal) {
            pushCase(ctx, `illegal "${cond.field}" transition ${t.from}→${t.illegal} denied`, actor, { method: 'update', path: target, data: { [cond.field]: t.illegal } }, 'DENY');
          }
        }
      }
      if (cond.kind === 'fieldEquals') {
        const bad = { [cond.field]: differentValue(cond.value) };
        pushCase(ctx, `wrong "${cond.field}" value denied`, actor, { method: 'update', path: target, data: bad }, 'DENY');
      }
      if (cond.kind === 'crossDoc') {
        const drift = { [cond.localField]: differentValue(baseData[cond.localField]) };
        pushCase(ctx, `"${cond.localField}" drifting from ${cond.collection}.${cond.remoteField} denied`, actor, { method: 'update', path: target, data: drift }, 'DENY');
      }
    }
  }

  // Claim-violation probes: every spec identity that fails the claim
  // conds gets an otherwise-satisfying DENY (own doc, good data); if
  // none fails, one synthesized claimless identity probes instead.
  if (claimConds(conds).length > 0) {
    const violators = spec.identities.filter((id) => !satisfiesClaims(id, conds));
    const probes: TestIdentity[] =
      violators.length > 0 ? violators.map(caseIdentity) : [{ uid: 'spec-no-claim' }];
    for (const probe of probes) {
      const pid = ctx.nextId();
      const pTargetId = pathUidOwned ? probe.uid : pid;
      const pTarget = docPath(col, pTargetId, probe.uid);
      const pData = satisfyingData(ctx, probe.uid);
      const what = `"${probe.uid}" without required claim denied`;
      if (op === 'create') {
        // Fresh self-owned slot for path-uid (see the create block).
        const fUid = pathUidOwned ? `${probe.uid}-new` : probe.uid;
        const fProbe: TestIdentity = { uid: fUid, ...(probe.token ? { token: probe.token } : {}) };
        const fPath = pathUidOwned ? docPath(col, fUid, fUid) : docPath(col, ctx.nextId(), fUid);
        pushCase(ctx, `"${probe.uid}" without required claim denied`, fProbe, { method: 'create', path: fPath, data: satisfyingData(ctx, fUid) }, 'DENY');
      } else if (op === 'list') {
        pushCase(ctx, what, probe, { method: 'list', path: listPath(col, probe.uid) }, 'DENY');
      } else {
        ctx.seed.set(pTarget, pData);
        const doPart: WorkspaceTestCase['do'] =
          op === 'update'
            ? { method: 'update', path: pTarget, data: benignUpdate(ctx, pData) }
            : { method: op, path: pTarget };
        pushCase(ctx, what, probe, doPart, 'DENY');
      }
    }
  }
}

/** Deny-by-default — the over-permissiveness tripwire. Anon + every
 *  spec identity must DENY on an ungranted (or explicitly denied) op.
 *  The probe doc is owned by the first identity so owner-shaped
 *  over-grants get caught. */
function deriveDeniedCell(ctx: CellCtx): void {
  const { spec, col } = ctx;
  const op = ctx.rule.op;
  const ownerId = spec.identities[0]!;
  const probeId = ctx.nextId();
  const targetId = ownedDocId(col, ownerId.uid, probeId);
  const target = docPath(col, targetId, ownerId.uid);
  const data = satisfyingData(ctx, ownerId.uid);
  if (op !== 'create') ctx.seed.set(target, data);

  const probes: Array<TestIdentity | null> = [null, ...spec.identities.map(caseIdentity)];
  for (const probe of probes) {
    const who = probe ? `"${probe.uid}"` : 'unauthenticated';
    const what = `deny-by-default: ${who} denied (op not granted)`;
    if (op === 'create') {
      // Create probes must hit non-existent docs (see deriveGrantedCell).
      // Path-uid identity probes act as `<uid>-dbd` (claims preserved,
      // self-owned fresh slot) so owner- and claim-shaped over-grants
      // are still caught.
      if (!col.ownerField && probe) {
        const fUid = `${probe.uid}-dbd`;
        const fProbe: TestIdentity = { uid: fUid, ...(probe.token ? { token: probe.token } : {}) };
        pushCase(ctx, what, fProbe, { method: 'create', path: docPath(col, fUid, fUid), data: satisfyingData(ctx, fUid) }, 'DENY');
      } else {
        const createData = col.ownerField && probe ? { ...data, [col.ownerField]: probe.uid } : data;
        pushCase(ctx, what, probe, { method: 'create', path: docPath(col, ctx.nextId(), probe?.uid ?? ownerId.uid), data: createData }, 'DENY');
      }
    } else if (op === 'list') {
      pushCase(ctx, what, probe, { method: 'list', path: listPath(col, probe?.uid ?? ownerId.uid) }, 'DENY');
    } else if (op === 'update') {
      pushCase(ctx, what, probe, { method: 'update', path: target, data: benignUpdate(ctx, data) }, 'DENY');
    } else {
      pushCase(ctx, what, probe, { method: op, path: target }, 'DENY');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// deriveTests — the matrix suite (one WorkspaceTestFile per collection)
// ─────────────────────────────────────────────────────────────────────

export function deriveTests(spec: AppSpecV1): WorkspaceTestFile[] {
  const files: WorkspaceTestFile[] = [];
  for (const col of spec.collections) {
    const seed = new Map<string, Record<string, unknown>>();
    const cases: WorkspaceTestCase[] = [];
    let n = 0;
    const colName = collectionPathOf(col.path);
    const nextId = () => `${colName.replace(/\//g, '-')}-d${++n}`;

    for (const op of FIRESTORE_METHODS) {
      const rule =
        spec.access.find((r) => r.op === op && resolveCollection(spec, r.collection) === col) ??
        null;
      const ctx: CellCtx = {
        spec,
        col,
        rule: rule ?? { collection: col.path, op, grant: 'deny' },
        conds: rule && rule.grant !== 'deny' ? rule.grant : [],
        seed,
        cases,
        nextId,
      };
      // A non-'deny' grant that the compiler emits as `if false` (a
      // non-empty, custom-free, auth-free grant with no op-applicable
      // predicate) is effectively denied — model it as a deny-by-default
      // cell so the derived probes match the compiled `if false`.
      const compilesToDeny =
        rule && rule.grant !== 'deny' && grantCompilesToDeny(rule.grant, op);
      if (!rule || rule.grant === 'deny' || compilesToDeny) deriveDeniedCell(ctx);
      else deriveGrantedCell(ctx);
    }

    if (cases.length === 0) continue;
    files.push({
      ...(seed.size > 0
        ? { seed: [...seed.entries()].map(([path, data]) => ({ path, data })) }
        : {}),
      cases,
    });
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────
// matrix summary (validation-event payload / spec card)
// ─────────────────────────────────────────────────────────────────────

export interface MatrixRow {
  collection: string;
  op: FirestoreMethod;
  /** 'deny' for ungranted/denied cells; otherwise human-readable
   *  condition summaries (empty grant → ['public']). */
  grant: 'deny' | string[];
}

export function summarizeCondition(c: Condition): string {
  switch (c.kind) {
    case 'authenticated':
      return 'signed in';
    case 'owner':
      return 'owner only';
    case 'claim':
      return `claim ${c.name} = ${JSON.stringify(c.equals)}`;
    case 'fieldEquals':
      return `${c.field} = ${JSON.stringify(c.value)}`;
    case 'fieldImmutable':
      return `${c.field} immutable`;
    case 'requiredFields':
      return `requires ${c.fields.join(', ')}`;
    case 'enumTransition':
      return `${c.field} follows its transitions`;
    case 'crossDoc':
      return `${c.localField} must match ${c.collection}.${c.remoteField}`;
    case 'custom':
      return `custom: ${c.rationale}`;
  }
}

/** The FULL matrix (every collection × op), deny-by-default cells
 *  included — the teaching surface the spec card renders. */
export function summarizeMatrix(spec: AppSpecV1): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const col of spec.collections) {
    for (const op of FIRESTORE_METHODS) {
      const rule =
        spec.access.find((r) => r.op === op && resolveCollection(spec, r.collection) === col) ??
        null;
      rows.push({
        collection: collectionPathOf(col.path),
        op,
        grant:
          !rule || rule.grant === 'deny'
            ? 'deny'
            : rule.grant.length === 0
              ? ['public']
              : rule.grant.map(summarizeCondition),
      });
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────
// failure → generating rule (repair-feedback quoting)
// ─────────────────────────────────────────────────────────────────────

function pathMatchesTemplate(template: string, path: string, method: FirestoreMethod): boolean {
  const t = template.split('/').filter((s) => s.length > 0);
  if (method === 'list' && t.length > 0 && isWildcard(t[t.length - 1]!)) t.pop();
  const p = path.split('/').filter((s) => s.length > 0);
  if (t.length !== p.length) return false;
  return t.every((seg, i) => isWildcard(seg) || seg === p[i]);
}

/** Resolve which access-matrix entry generated a derived case, from the
 *  case's (method, path) coordinates. Returns the rule (for quoting in
 *  repair feedback) or null — null on an ungranted cell means the
 *  failure came from a deny-by-default probe. */
export function findRuleForCase(
  spec: AppSpecV1,
  method: FirestoreMethod,
  path: string,
): AccessRule | null {
  for (const rule of spec.access) {
    if (rule.op !== method) continue;
    const col = resolveCollection(spec, rule.collection);
    if (!col) continue;
    if (pathMatchesTemplate(col.path, path, method)) return rule;
  }
  return null;
}
