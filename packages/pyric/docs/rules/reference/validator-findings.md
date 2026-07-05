# Validator findings

`validateFirestoreRules(ast)` returns an array of `ValidationFinding`:

```ts
interface ValidationFinding {
  code: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  path: string;          // match path, or '/' for whole-file findings
  operation?: string;    // 'read', 'write', 'create, update', etc.
  message: string;
}
```

Findings are grouped by code family:

- `SEC-*` — security
- `SEM-*` — semantics (rules that compile but evaluate incorrectly)
- `QUA-*` — quality
- `STR-*` — structure

The validator is distinct from the linter: it reports issues a human reviewer would flag, regardless of compilation or runtime budget. Run both for full coverage.

## Security (`SEC`)

### `SEC-1` — Public write (`critical`)

A write rule (`write`, `create`, `update`, or `delete`) with `if true`. Anyone can write without authentication.

### `SEC-2` — Public read at recursive wildcard (`critical`)

A read rule with `if true` whose match path uses `{document=**}`. Every document under the prefix is readable by anyone.

### `SEC-3` — Write without auth check (`high`)

A write rule whose condition does not reference `request.auth` (directly or through any called function). Catches rules that gate on data shape only.

### `SEC-4` — No default deny (`medium`)

The ruleset lacks a default-deny block (`match /{document=**} { allow read, write: if false; }`). Without it, unmatched paths fall through to Firestore's defaults, which can surprise.

### `SEC-5` — Recursive wildcard with non-deny rule (`high`)

A `{document=**}` match block has an allow rule that isn't trivially `if false`. Because recursive matches override specific matches, the rule effectively governs every document under the prefix.

### `SEC-6` — Write without data validation (`high`)

A `create` or `update` rule that does not reference `request.resource.data` (directly or transitively). Any payload shape is accepted.

## Semantics (`SEM`)

### `SEM-1` — `request.resource.data` on a read rule (`high`)

Read rules don't carry a `request.resource` — the field is unset. The predicate silently denies.

### `SEM-2` — `resource.data` on a create rule (`high`)

The document doesn't exist yet on `create`, so `resource.data` is null. Use `request.resource.data` instead.

### `SEM-3` — More than 10 document reads (`high`)

`get()` / `exists()` count exceeds the documented Firestore limit of 10 per rule. Same threshold as the linter's `GET_COUNT` error band.

### `SEM-4` — Call to undefined function (`high`)

A function call references a name that isn't defined in the current scope or any parent scope.

## Quality (`QUA`)

### `QUA-1` — Hardcoded `true` (`medium` for writes, `low` for reads)

Same shape as the linter's `PERMISSIVE_RULE`. Reported here at lower severity than the linter blocks the deploy at — the validator is advisory.

### `QUA-2` — Empty match block (`low`)

A match block with no allow rules, no children, and no functions. Dead code.

### `QUA-3` — Duplicate function names (`medium`)

Two functions share a name within the same scope. Behaviour depends on declaration order — confusing at best.

### `QUA-4` — Unused function (`low`)

A function is defined but never called.

### `QUA-5` — Deep condition (`low`)

A single rule's predicate exceeds an internal depth threshold. Consider extracting helpers.

## Structure (`STR`)

### `STR-1` — Match with no wildcard (`low`)

A match path with no `{wildcard}` segment matches exactly one document. Usually a sign of a typo or a missing wildcard segment.

### `STR-2` — Nested match without allows (`medium`)

A parent block with no allow rules but with nested matches. Often a sign that the parent intended to lock the collection but ended up doing nothing.

### `STR-3` — Overlapping sibling paths (`low`)

Two sibling match blocks whose paths could match the same document. The more permissive rule wins, which may not be intended.

## Severity model

The validator's `severity` scale (`critical`, `high`, `medium`, `low`) is more granular than the linter's (`error`, `warning`). The values map as follows for tooling that treats them as block / advisory:

| Severity | Recommended action |
|---|---|
| `critical` | Block deploy. |
| `high` | Block by default; allow override with explicit human ack. |
| `medium` | Surface in review; do not block. |
| `low` | Surface in review; do not block. |

The mapping is a convention, not enforced — callers compose their own gates.
