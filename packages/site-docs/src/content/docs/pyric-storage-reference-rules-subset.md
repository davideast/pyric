---
title: "Storage rules subset"
group: "pyric / storage"
section: "Reference"
order: 124
---
# Storage rules subset

The Storage rules grammar in the v1 scope. Anything not listed is out of scope and will produce a parse error.

## Service header
```
service firebase.storage {
  // ...
}
```
Required. Anything other than `firebase.storage` fails parsing.

## Path matching

Three segment types:

- **Static segments**: `sessions`, `images`, `uploads`.
- **Single-segment parameters**: `{sessionId}`, `{uid}`.
- **Multi-segment wildcards**: `{allPaths=**}` — matches the rest of the path.

Nested `match` blocks compose naturally:
```
match /b/{bucket}/o {
  match /users/{uid} {
    match /private/{file=**} {
      allow read: if request.auth.uid == uid;
    }
  }
}
```
Path variables bind to the surrounding scope — `uid` from the parent match is in scope in the inner allow condition.

## Allow conditions

Two verbs:

- `allow read: if <expr>` — matches `getBytes`, `getBlob`, `getMetadata`.
- `allow write: if <expr>` — matches `uploadBytes`, `uploadString`, `updateMetadata`, `deleteObject`.

The granular forms (`get`, `list`, `create`, `update`, `delete`) are deferred. The parser rejects them.

## Request bindings

- `request.auth` — `null` for anonymous, otherwise `{ uid, token }`.
- `request.auth.uid` — string.
- `request.auth.token['claim']` — bracket access on the token object.
- `request.resource.size` — byte count of the proposed upload payload.
- `request.resource.contentType` — MIME string of the proposed upload.
- `request.method` — `'get'` / `'create'` / `'update'` / `'delete'`.
- `request.path` — full path of the object.

For deletes, `request.resource == null` — the carve-out lets delete rules accept `null` without confusing the parser. See [Enforce Storage rules](pyric-storage-how-to-enforce-rules) for the pattern.

## Resource bindings

For existing objects:

- `resource.size` — byte count.
- `resource.contentType` — MIME string.
- `resource.metadata` — bracket-access for custom metadata: `resource.metadata['sessionId']`.

Deep dotted access (`resource.metadata.sessionId`) is deferred. Use the bracket form.

## Operators

- **Unary**: `!`.
- **Binary**: `&&`, `||`, `==`, `!=`, `<`, `>`, `<=`, `>=`, `+`, `-`, `*`, `/`.
- **Parentheses** for grouping.
- **Short-circuit** evaluation matches Firestore's rules engine.

## Literal values

Strings (`'...'` or `"..."`), numbers, booleans (`true` / `false`), `null`.

## Out of scope

These produce parse errors:

- `request.time` and time-based rules.
- `matches()` / regex predicates.
- Rule function definitions (`function isOwner() { return ... }`).
- Deep dotted access into `customMetadata.<field>` — use the bracket form.
- Granular verbs (`get`, `list`, `create`, `update`, `delete`).

See [Implementation scope and deferred features](pyric-storage-explanation-implementation-scope) for the reasoning.

## Where to look next

- For testing rule expressions independently, see [Test rule expressions independently](pyric-storage-how-to-test-rule-expressions).
- For the engine's evaluation contract (`evaluateStorageRules`), see [Public API](pyric-storage-reference-api#rules).
