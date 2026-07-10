---
title: "How to test rule expressions independently"
navLabel: "Test rule expressions"
group: "pyric / storage"
section: "How-to"
order: 145
---
# How to test rule expressions independently

This guide shows you how to verify a Storage rule expression without uploading anything. Useful when iterating on a complex rule or building a rules-test harness.

## The two functions
```ts
import { parseStorageRules, evaluateStorageRules } from 'pyric/storage';
```
- **`parseStorageRules(source)`** returns a `ParsedRules` object. Throws a `SyntaxError` with line/column info if the source is malformed.
- **`evaluateStorageRules(rules, input)`** takes parsed rules plus a synthetic request shape and returns `{ allowed: true } | { allowed: false; reason }`.

## A complete test
```ts
const source = `service firebase.storage {
  match /b/{bucket}/o {
    match /sessions/{id} {
      allow write: if request.auth != null
                   && request.resource.size < 10 * 1024 * 1024
                   && request.resource.contentType == 'application/json';
      allow read: if request.auth != null;
    }
  }
}`;

const rules = parseStorageRules(source);

// Authenticated, valid upload.
const okay = evaluateStorageRules(rules, {
  path: 'b/pyric-default/o/sessions/n1',
  method: 'create',
  auth: { uid: 'alice', token: {} },
  resource: { size: 1024, contentType: 'application/json' },
});
console.log(okay);  // { allowed: true }

// Anonymous upload denies.
const denied = evaluateStorageRules(rules, {
  path: 'b/pyric-default/o/sessions/n1',
  method: 'create',
  auth: null,
  resource: { size: 1024, contentType: 'application/json' },
});
console.log(denied);
// { allowed: false, reason: 'request.auth != null failed' }
```
The synthetic input mirrors what the actual handler builds when an operation runs against a sandbox-backed handle.

## The input shape
```ts
{
  path: string;                          // full path, including bucket prefix
  method: 'get' | 'create' | 'update' | 'delete';
  auth: { uid: string; token: object } | null;
  resource?: { size: number; contentType: string };  // for writes
  existing?: { size: number; contentType: string; metadata?: Record<string, string> };  // for read/update/delete
}
```
`resource` represents `request.resource` (what's being uploaded). `existing` represents `resource` (what's already stored). Set whichever the rule references.

## Why not go through the handler

Using `evaluateStorageRules` directly:

- Doesn't require constructing a sandbox.
- Doesn't require uploading any data.
- Is fast (microseconds, it only walks the AST).

For iterating on rule logic or building a parametric rules-test harness, this is the right surface. For end-to-end verification (does the actual handler enforce the rule correctly?) use `getStorageSandbox(target, { rules: source })` and exercise it through normal operations.

## What you can't test this way

The synthetic input is what *you* fabricate. The real handler builds its input from the operation arguments, so if your handler-side wiring has a bug (passing wrong content-type, wrong size), `evaluateStorageRules` won't catch it. The two surfaces verify different layers:

- `evaluateStorageRules` verifies the rule's *logic*.
- `getStorageSandbox` with the rule deployed verifies the *integration*.

For a full test, run both. Most tests need only one or the other.

## Where to look next

- For the input shape and the rule engine details, see [Public API: Rules](../pyric-storage-reference-api/#rules).
- For the grammar these functions parse, see [Storage rules subset](../pyric-storage-reference-rules-subset/).
