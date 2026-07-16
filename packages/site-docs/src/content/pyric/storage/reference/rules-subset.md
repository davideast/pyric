---
title: "Storage rules language reference"
group: "pyric / storage"
section: "Reference"
order: 80
---
# Storage rules language reference

Usage reference for the Storage rules constructs shown in this package. This page is not an availability inventory: run `pyric can-i-use storage-rules/<construct>` for the current support, fidelity, assurance, caveats, and evidence before relying on a construct.

## Service header

```rules
service firebase.storage {
  // ...
}
```

Required. Anything other than `firebase.storage` fails parsing.

## Path matching

Three segment types:

- **Static segments**: `sessions`, `images`, `uploads`.
- **Single-segment parameters**: `{sessionId}`, `{uid}`.
- **Multi-segment wildcards**: `{allPaths=**}` matches the rest of the path.

Nested `match` blocks compose naturally:

```rules
match /b/{bucket}/o {
  match /users/{uid} {
    match /private/{file=**} {
      allow read: if request.auth.uid == uid;
    }
  }
}
```

Path variables bind to the surrounding scope: `uid` from the parent match is in scope in the inner allow condition.

## Allow conditions

Coarse umbrellas and granular verbs, matching production Storage semantics.

- `allow read: if <expr>` — the umbrella for `get` + `list`.
- `allow write: if <expr>` — the umbrella for `create` + `update` + `delete`.
- `allow get` — `getBlob` / `getBytes` / `getMetadata`.
- `allow list` — `listAll`.
- `allow create` — `uploadBytes` / `uploadString` to a path with no existing object.
- `allow update` — `uploadBytes` / `uploadString` over an existing object, and `updateMetadata`.
- `allow delete` — `deleteObject`.

A granular grant covers only its own verb: `allow get` does not grant `list`, and `allow create` does not grant `update` or `delete`. Verbs may be comma-separated in one clause (`allow get, list: if <expr>`). A verb with no applicable grant is denied.

## Rule functions

User-defined functions are supported, including `let` bindings:

```rules
function isOwner(uid) {
  let owner = resource.metadata['owner'];
  return request.auth != null && request.auth.uid == owner;
}
```

Recursion depth is capped; a function that errors mid-evaluation denies rather than throwing past the rule (deny-on-error).

## Request bindings

- `request.auth`: `null` for anonymous, otherwise `{ uid, token }`.
- `request.auth.uid`: string.
- `request.auth.token['claim']`: bracket access on the token object.
- `request.resource.size`: byte count of the proposed upload payload.
- `request.resource.contentType`: MIME string of the proposed upload.
- `request.method`: `'get'` / `'create'` / `'update'` / `'delete'`.
- `request.path`: full path of the object.
- `request.time`: a `Timestamp`. Compare with `timestamp.date(...)` literals or other `request.time` values.

For deletes, `request.resource == null`. The carve-out lets delete rules accept `null` without confusing the parser. See [Enforce Storage rules](../how-to/enforce-rules.md) for the pattern.

## Resource bindings

For existing objects:

- `resource.size`: byte count.
- `resource.contentType`: MIME string.
- `resource.metadata`: custom metadata, accessible both by bracket (`resource.metadata['sessionId']`) and dotted form (`resource.metadata.sessionId`).
- `resource.name`: the object's **full path within the bucket** (`uploads/pic.png`) — the Cloud Storage object-name convention. This is not the client SDK's `FullMetadata.name`, which is only the last path segment.
- `resource.bucket`: the bucket the object resides in.
- `resource.timeCreated` / `resource.updated`: the object's creation and last-update timestamps. The update-time field is `updated`; the language has no `resource.timeUpdated`.

`duration.value(n, unit)` builds a duration, so a freshness window reads:

```
allow delete: if request.time < resource.timeCreated + duration.value(1, 'h');
```

Reading a field an object does not carry is an evaluation error, and an error **denies** — including through a negation, so `resource.name != 'x'` on an object with no name denies rather than allowing.

## Cross-service lookups

`firestore.get(path)` and `firestore.exists(path)` read a Firestore document from inside a Storage rule, with `$(expr)` interpolation for dynamic path segments:

```rules
allow write: if firestore.exists(/databases/(default)/documents/sessions/$(request.auth.uid));
```

## String matching

`matches()` does whole-string-anchored regex matching, evaluated with RE2 semantics. Constructs RE2 can't express (backreferences, lookahead/lookbehind) are denied at parse time rather than silently mismatching.

## Operators

- **Unary**: `!`.
- **Binary**: `&&`, `||`, `==`, `!=`, `<`, `>`, `<=`, `>=`, `+`, `-`, `*`, `/`.
- **Parentheses** for grouping.
- **Short-circuit** evaluation matches Firestore's rules engine.

## Literal values

Strings (`'...'` or `"..."`), numbers, booleans (`true` / `false`), `null`, `timestamp.date(...)`.

## Where to look next

- For testing rule expressions independently, see [Test rule expressions independently](../how-to/test-rule-expressions.md).
- For the engine's evaluation contract (`evaluateStorageRules`), see [Public API](./api.md#rules).
- For the one known production-vs-evaluator divergence (a `resource == null`
  create edge case) and the oracle-capture evidence behind this page's
  claims, see [Storage rules evaluator conformance gaps](./conformance-gaps.md).
