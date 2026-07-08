# The session-archive driver

`pyric/storage` was scoped around one use case: storing completed agent sessions so a user can come back to them later. This page explains the use case and how it shaped the package.

## What an agent session is

Pyric's agent runtime produces sessions — a record of one task. The session captures the prompt, the tool calls, the LLM responses, the events streamed to the UI, the final outcome. A session is small (kilobytes, occasionally a megabyte) but unbounded — there can be thousands of them over time.

A user finishing a session typically wants two things:

- **Persistence**: come back later, see the session as it was.
- **Sharing**: send a session to a colleague or attach it to a bug report.

The sharing requirement implies a real bucket — `pyric_sessions/<userId>/<sessionId>.json` on production Firebase Storage, with appropriate access rules. The persistence requirement implies the same flow needs to work locally first.

## Why an in-process backend mattered

The playground is a browser app. It mutates documents and rules in-place; sessions naturally land there before any explicit upload. Two implications:

- **Latency.** A user shouldn't wait on a network round-trip for "save my session". Sub-millisecond reads and writes matter.
- **Offline.** A user on a flaky connection still wants their sessions to be there.

A real Cloud Storage round-trip per session save is the wrong shape. So is "save everything in `localStorage`" (wrong quota, wrong API). IndexedDB lands in the middle — local, persistent, asynchronous.

## Why rules mattered

The eventual upload to production is gated by rules. We wanted those rules visible at session-save time so the user sees "this would be rejected" before they hit upload. The rule shape:

```
service firebase.storage {
  match /b/{bucket}/o {
    match /sessions/{sessionId} {
      allow write: if request.auth != null
                   && (request.resource == null
                       || (request.resource.size < 10 * 1024 * 1024
                           && request.resource.contentType == 'application/json'));
      allow read: if request.auth != null;
    }
  }
}
```

Three real-world bits embedded:

- **Anonymous denials.** Anyone hitting "save" while not signed in gets blocked.
- **Size limits.** A 50 MB session is almost certainly a bug; reject early.
- **Content-type pinning.** JSON only, so a non-JSON upload doesn't masquerade.
- **Delete carve-out.** `request.resource == null` lets deletes through (they don't carry a payload).

These were the *real* rules used in production. Tested locally first means the engineer iterating on them sees denials in their playground tab, not in their analytics dashboard the next day.

## Why the rule engine is local to this package

`pyric/rules` is a sibling-package answer to the same problem for Firestore — parse, lint, simulate. We didn't reuse it because the Storage rules grammar is different from the Firestore rules grammar. Different identifiers (`request.resource.contentType` doesn't exist in Firestore), different verbs (`read` / `write` vs `read` / `write` / `get` / `list` / `create` / `update` / `delete`), different evaluation contexts.

A separate parser + evaluator for Storage rules avoided the headache of multiplexing two grammars in one package. It also kept the rule subset small — the Storage rules v1 scope covers what session archives needed, nothing more.

When more Storage features land (custom verbs, time gating, regex), the same package can grow to absorb them. When a `pyric/storage-admin` sibling lands, the parser stays here and the admin shape pulls it in.

## Why `bucket` is a label, not a partition

Production Storage has real multi-bucket isolation. We didn't reproduce that because the session archive uses one bucket per project — multi-bucket is a feature most consumers don't reach. The `bucket` option round-trips through metadata so generated metadata matches production shape; the actual data is one IndexedDB partition.

When a multi-bucket scenario actually matters to a consumer, the partition can light up. Until then, treating it as a label kept the implementation small.

## What the use case did not need

A few things we explicitly didn't build because the session archive doesn't need them:

- **Resumable uploads.** Sessions are small; one-shot uploads are fine.
- **Progress events.** A 100 ms upload doesn't need a progress bar.
- **Server-side transformations.** Sessions are JSON; we don't generate thumbnails.
- **Cloud Functions triggers on upload.** No server-side logic to invoke.
- **Granular allow verbs.** Read vs write is the only distinction sessions need.

Each is a real Storage feature; each is deferred. The deferral list lives in [Implementation scope and deferred features](./implementation-scope.md).

## Why this matters

The v1 scope's scope wasn't picked from a feature wishlist — it was driven by one concrete consumer. Every line in this package serves the session-archive flow. When a future consumer comes along with a different use case (large files, server-side triggers, real multi-bucket), the package will grow to absorb their needs *because* they're real, not speculative.

This is the pattern: build what's needed, document what's deferred, expand on demand.
