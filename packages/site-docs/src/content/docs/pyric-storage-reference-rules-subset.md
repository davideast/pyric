---
title: "Storage rules subset"
group: "pyric / storage"
section: "Reference"
order: 148
---
# Storage rules subset

The Storage rules grammar in the v1 scope. Anything not listed is out of scope and will produce a parse error.

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

Both the umbrella verbs and the granular verbs work, matching production semantics:

- `allow read: if <expr>` matches `getBytes`, `getBlob`, `getMetadata`.
- `allow write: if <expr>` matches `uploadBytes`, `uploadString`, `updateMetadata`, `deleteObject`.
- `allow get: if <expr>` — reads a single object (`getBytes`, `getBlob`, `getMetadata`).
- `allow list: if <expr>` — `listAll` against the matched prefix.
- `allow create: if <expr>` — `uploadBytes` / `uploadString` against a path with no existing object.
- `allow update: if <expr>` — `uploadBytes` / `uploadString` against a path with an existing object, or `updateMetadata`.
- `allow delete: if <expr>` — `deleteObject`.

`read` is the umbrella for `get` + `list`; `write` is the umbrella for `create` + `update` + `delete` — same as production. A rule can mix umbrella and granular verbs across sibling `match` blocks.

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

For deletes, `request.resource == null`. The carve-out lets delete rules accept `null` without confusing the parser. See [Enforce Storage rules](../pyric-storage-how-to-enforce-rules/) for the pattern.

## Resource bindings

For existing objects:

- `resource.size`: byte count.
- `resource.contentType`: MIME string.
- `resource.metadata`: custom metadata, accessible both by bracket (`resource.metadata['sessionId']`) and dotted form (`resource.metadata.sessionId`).

`resource.timeCreated` / `resource.updated` are still unsupported — see [Implementation scope](../pyric-storage-explanation-implementation-scope/).

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

## Out of scope

These still produce parse or evaluation errors:

- `resource.timeCreated` / `resource.updated` metadata fields.
- Regex constructs that RE2 can't express inside `matches()`.

See [Implementation scope and deferred features](../pyric-storage-explanation-implementation-scope/) for the reasoning.

## Where to look next

- For testing rule expressions independently, see [Test rule expressions independently](../pyric-storage-how-to-test-rule-expressions/).
- For the engine's evaluation contract (`evaluateStorageRules`), see [Public API](../pyric-storage-reference-api/#rules).
