/**
 * AppSpecV1 — the compact access-matrix spec for draft-then-validate
 * (plans/app-spec.md §3). The fourth draft fence parses into this shape;
 * `deriveTests` (./derive.ts) turns it into workspace-test files the
 * host runs against the candidate rules.
 *
 * Schema mechanism (plans/app-spec.md §5 "schema-first single
 * declaration"): zod — already the repo convention for tool parameter
 * schemas (pyric's `TestCaseSchema`) and a playground dependency. ONE
 * zod declaration yields all three artifacts mechanically:
 *   - the TS type            via `z.infer` (`AppSpecV1`)
 *   - the JSON schema        via `zod-to-json-schema` (`appSpecJsonSchema`)
 *   - the runtime validator  via `safeParse` (+ referential checks,
 *                            `validateAppSpec`)
 * No pinning test is needed — the three cannot drift from one source.
 *
 * Type cohesion (§5, binding): the spec composes from EXECUTABLE types,
 * it never redeclares. `AccessRule.op` is pyric/rules' canonical
 * `FirestoreMethod`; identities map onto `SeedUser` / the runner's
 * `TestIdentity` in ./derive.ts. `FieldSpec.type` aligns with the
 * discovery field vocabulary (pyric-tools/discover `FirestoreScalarType`
 * naming: integer/double/timestamp/bytes/geopoint — not `number`/`date`),
 * minus `null` (nullability is an annotation there, not a type), plus
 * the structured kind names map/array/reference.
 *
 * Persisted as a plain workspace file (`/workspace/app.spec.json`) for
 * transparency — NOT enforced after generation; editing it does nothing
 * until the next draft.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { FIRESTORE_METHODS, type FirestoreMethod } from 'pyric/rules';

// ─────────────────────────────────────────────────────────────────────
// Declarations (one source — type + JSON schema + validator derive)
// ─────────────────────────────────────────────────────────────────────

/** A test/demo identity. Maps to a pyric `SeedUser` (deriveIdentities)
 *  and to a runner case identity `{ uid, token: claims }`. */
export const IdentitySpecSchema = z.object({
  uid: z.string().min(1).describe('Stable test uid, e.g. "alice"'),
  description: z.string().optional().describe('Role in the app, e.g. "a signed-in customer"'),
  email: z.string().optional(),
  displayName: z.string().optional(),
  claims: z
    .record(z.unknown())
    .optional()
    .describe('Custom claims; read as request.auth.token.<name> in rules'),
});
export type IdentitySpec = z.infer<typeof IdentitySpecSchema>;

/** Field type vocabulary — aligned with the discovery crawler's
 *  `FirestoreScalarType` + structured `FieldType.kind` names. */
export const FIELD_TYPES = [
  'string',
  'integer',
  'double',
  'boolean',
  'timestamp',
  'bytes',
  'geopoint',
  'reference',
  'array',
  'map',
] as const;
export type FieldTypeName = (typeof FIELD_TYPES)[number];

export const FieldSpecSchema = z.object({
  name: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional().describe('Must be present on create'),
  immutable: z.boolean().optional().describe('Must never change after create'),
  enum: z
    .array(z.union([z.string(), z.number()]))
    .optional()
    .describe('Closed value set, e.g. order status values'),
  transitions: z
    .record(z.array(z.string()))
    .optional()
    .describe('Legal enum transitions: current value → allowed next values'),
});
export type FieldSpec = z.infer<typeof FieldSpecSchema>;

export const CollectionSpecSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Path template, e.g. "orders/{orderId}" or "users/{uid}/items/{itemId}"'),
  description: z.string().optional(),
  ownerField: z
    .string()
    .optional()
    .describe('Doc field holding the owner uid; omit when the doc ID IS the uid (users/{uid})'),
  fields: z.array(FieldSpecSchema),
});
export type CollectionSpec = z.infer<typeof CollectionSpecSchema>;

/** The nine condition kinds — a closed algebra; everything except
 *  `custom` derives tests mechanically. Conditions in one grant AND. */
export const ConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('authenticated') }),
  z.object({ kind: z.literal('owner') }),
  z.object({ kind: z.literal('claim'), name: z.string(), equals: z.unknown() }),
  z.object({ kind: z.literal('fieldEquals'), field: z.string(), value: z.unknown() }),
  z.object({ kind: z.literal('fieldImmutable'), field: z.string() }),
  z.object({ kind: z.literal('requiredFields'), fields: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('enumTransition'), field: z.string() }),
  z.object({
    kind: z.literal('crossDoc'),
    collection: z.string().describe('Remote collection name, e.g. "menuItems"'),
    docIdFrom: z.string().describe('Local field holding the remote doc id'),
    remoteField: z.string(),
    localField: z.string(),
  }),
  z.object({
    kind: z.literal('custom'),
    rulesExpr: z.string().describe('Raw rules expression — NOT derivable; supply your own test cases'),
    rationale: z.string(),
  }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

export const AccessRuleSchema = z.object({
  collection: z.string().describe('Must equal a declared collection path'),
  // The canonical method union — imported, never redeclared (§5).
  op: z.enum(FIRESTORE_METHODS),
  grant: z
    .union([z.literal('deny'), z.array(ConditionSchema)])
    .describe("'deny', or the AND of all listed conditions ([] = public)"),
});
export type AccessRule = z.infer<typeof AccessRuleSchema>;
// Compile-time cohesion pin: the spec's op IS the canonical union.
type _OpIsCanonical = AccessRule['op'] extends FirestoreMethod ? true : never;
const _opIsCanonical: _OpIsCanonical = true;
void _opIsCanonical;

export const AppSpecV1Schema = z.object({
  meta: z.object({
    title: z.string(),
    assumptions: z.array(z.string()),
  }),
  identities: z.array(IdentitySpecSchema).min(1),
  collections: z.array(CollectionSpecSchema).min(1),
  access: z.array(AccessRuleSchema),
});
export type AppSpecV1 = z.infer<typeof AppSpecV1Schema>;

/** JSON schema rendering of the SAME declaration (draft-prompt /
 *  documentation surface). */
export function appSpecJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(AppSpecV1Schema, 'AppSpecV1') as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────
// Path helpers (shared with the deriver)
// ─────────────────────────────────────────────────────────────────────

/** 'orders/{orderId}' → 'orders'; 'users/{uid}/items/{i}' → segments
 *  with wildcards stripped from the tail. Collection-path form used for
 *  `list` cases and crossDoc collection matching. */
export function collectionPathOf(template: string): string {
  const segs = template.split('/').filter((s) => s.length > 0);
  if (segs.length > 0 && isWildcard(segs[segs.length - 1]!)) segs.pop();
  return segs.join('/');
}

export function isWildcard(seg: string): boolean {
  return seg.startsWith('{') && seg.endsWith('}');
}

/** Does a collection template's doc ID double as the owner uid?
 *  True when no `ownerField` is declared — `owner` then means
 *  "the final path wildcard equals request.auth.uid" (users/{uid}). */
export function isPathUidOwned(col: CollectionSpec): boolean {
  return !col.ownerField;
}

/**
 * Resolve the owner uid a CONCRETE document path implies for a
 * path-uid-owned collection — the segment under the FINAL wildcard slot
 * of the template (users/{uid} → the uid; users/{uid}/items/{itemId} →
 * the uid segment, since the doc-id wildcard is the tail and the uid is
 * the intermediate one). Returns null when the path's shape doesn't match
 * the template or there is no owner-bearing wildcard. ownerField-owned
 * collections resolve their owner from doc data, not the path, so this
 * returns null for them. Inverse of the deriver's `docPath`.
 */
export function ownerUidFromPath(col: CollectionSpec, path: string): string | null {
  if (col.ownerField) return null;
  const t = col.path.split('/').filter((s) => s.length > 0);
  const p = path.split('/').filter((s) => s.length > 0);
  if (t.length !== p.length) return null;
  // Index of the wildcard that carries the owner uid: the last wildcard
  // for a single-wildcard template (users/{uid}); otherwise the wildcard
  // BEFORE the final (doc-id) wildcard for a rooted subcollection.
  const wildIdxs = t.map((s, i) => (isWildcard(s) ? i : -1)).filter((i) => i >= 0);
  if (wildIdxs.length === 0) return null;
  const ownerIdx = wildIdxs.length === 1 ? wildIdxs[0]! : wildIdxs[wildIdxs.length - 2]!;
  // Every non-wildcard segment must match for the path to be this collection.
  for (let i = 0; i < t.length; i++) {
    if (!isWildcard(t[i]!) && t[i] !== p[i]) return null;
  }
  return p[ownerIdx] ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Runtime validator: structural parse + referential integrity
// ─────────────────────────────────────────────────────────────────────

export type SpecValidation =
  | { ok: true; spec: AppSpecV1 }
  | { ok: false; errors: string[] };

function fieldNames(col: CollectionSpec): Set<string> {
  return new Set(col.fields.map((f) => f.name));
}

/** Quote an access rule compactly for error messages / repair feedback. */
export function quoteRule(rule: AccessRule): string {
  return JSON.stringify(rule);
}

/**
 * Validate an unknown value as an AppSpecV1. Structural errors come from
 * zod; referential errors enforce that the matrix only talks about
 * declared things:
 *   - one rule per (collection, op) cell (matrix semantics);
 *   - every rule's `collection` is a declared collection path;
 *   - every condition field exists on that collection;
 *   - `enumTransition` fields declare `enum` + `transitions`;
 *   - `crossDoc` resolves: remote collection exists, remoteField exists
 *     there, docIdFrom/localField exist locally.
 * Every error quotes the offending entry — repair feedback re-uses the
 * messages verbatim.
 */
export function validateAppSpec(input: unknown): SpecValidation {
  const parsed = AppSpecV1Schema.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    return { ok: false, errors };
  }
  const spec = parsed.data;
  const errors: string[] = [];

  const byPath = new Map<string, CollectionSpec>();
  const byName = new Map<string, CollectionSpec>();
  for (const col of spec.collections) {
    byPath.set(col.path, col);
    byName.set(collectionPathOf(col.path), col);
  }

  const seenCells = new Set<string>();
  for (const rule of spec.access) {
    const cell = `${rule.collection} ${rule.op}`;
    if (seenCells.has(cell)) {
      errors.push(`duplicate access entry for "${cell}" — one rule per collection × op: ${quoteRule(rule)}`);
    }
    seenCells.add(cell);

    const col = byPath.get(rule.collection) ?? byName.get(rule.collection);
    if (!col) {
      errors.push(
        `access rule names unknown collection "${rule.collection}" (declared: ${spec.collections.map((c) => c.path).join(', ')}): ${quoteRule(rule)}`,
      );
      continue;
    }
    if (rule.grant === 'deny') continue;

    const names = fieldNames(col);
    const requireField = (field: string, what: string): void => {
      if (!names.has(field)) {
        errors.push(`${what} references field "${field}" not declared on ${col.path}: ${quoteRule(rule)}`);
      }
    };
    for (const cond of rule.grant) {
      switch (cond.kind) {
        case 'fieldEquals':
          requireField(cond.field, 'fieldEquals condition');
          break;
        case 'fieldImmutable':
          requireField(cond.field, 'fieldImmutable condition');
          break;
        case 'requiredFields':
          for (const f of cond.fields) requireField(f, 'requiredFields condition');
          break;
        case 'enumTransition': {
          requireField(cond.field, 'enumTransition condition');
          const fs = col.fields.find((f) => f.name === cond.field);
          if (fs && (!fs.enum || fs.enum.length === 0)) {
            errors.push(`enumTransition field "${cond.field}" on ${col.path} declares no enum values: ${quoteRule(rule)}`);
          }
          if (fs && (!fs.transitions || Object.keys(fs.transitions).length === 0)) {
            errors.push(`enumTransition field "${cond.field}" on ${col.path} declares no transitions map: ${quoteRule(rule)}`);
          }
          break;
        }
        case 'crossDoc': {
          requireField(cond.docIdFrom, 'crossDoc docIdFrom');
          requireField(cond.localField, 'crossDoc localField');
          const remote = byName.get(cond.collection) ?? byPath.get(cond.collection);
          if (!remote) {
            errors.push(`crossDoc references unknown collection "${cond.collection}": ${quoteRule(rule)}`);
          } else if (!fieldNames(remote).has(cond.remoteField)) {
            errors.push(`crossDoc remoteField "${cond.remoteField}" not declared on ${remote.path}: ${quoteRule(rule)}`);
          }
          break;
        }
        case 'owner': {
          // ownerField-based or path-uid — both fine; but ownerField,
          // when declared, must be a real field.
          if (col.ownerField && !names.has(col.ownerField)) {
            errors.push(`collection ${col.path} declares ownerField "${col.ownerField}" but no such field exists`);
          }
          break;
        }
        case 'authenticated':
        case 'claim':
        case 'custom':
          break;
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, spec };
}

/** Resolve a rule's collection spec (exact path or collection-name
 *  match — same resolution `validateAppSpec` enforces). */
export function resolveCollection(spec: AppSpecV1, ref: string): CollectionSpec | null {
  for (const col of spec.collections) {
    if (col.path === ref || collectionPathOf(col.path) === ref) return col;
  }
  return null;
}
