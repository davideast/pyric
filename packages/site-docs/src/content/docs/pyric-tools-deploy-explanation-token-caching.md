---
title: "Token caching and memoizeTtl"
group: "pyric-tools / deploy"
section: "Explanation"
order: 72
---
# Token caching and `memoizeTtl`

OAuth access tokens have a TTL, typically 3600 seconds for Google Cloud. Refresh too often and you waste round trips and rate limits; refresh too late and a token expires mid-deploy and the operation fails. `memoizeTtl` is the package's answer to "when do I get a fresh token?"

## The 90% rule

`memoizeTtl` refreshes at 90% of the TTL by default. With a 3600-second token that means the cached value expires (from the memoiser's perspective) at 3240 seconds and the *next* call after that triggers a refresh.

Why 90% rather than 100% or 50%:

- **Not 100%**: a token with 5 seconds left is dangerous. If your deploy takes longer than that you'll get a 401 mid-flight. Refreshing slightly early gives you a head-start buffer.
- **Not 50%**: you'd double your token-exchange traffic for no benefit. Google's exchange endpoint has its own rate limits and quota, and being a good citizen costs nothing.
- **90% is the sweet spot** for the common case: enough buffer to cover an operation that takes minutes; not so much buffer that you refresh constantly.

Callers can override via `refreshAtFraction`.

## Two resolver shapes

`memoizeTtl` accepts two resolver shapes:
```ts
// Plain string — caller must supply ttlMs.
memoizeTtl(async () => fetchTokenSomehow(), { ttlMs: 3600_000 });

// Structured — TTL inferred from the returned shape.
memoizeTtl(async () => ({ token: '…', expiresIn: 3600 }));
```
The plain-string form is for cases where the caller already knows the TTL (test fixtures, hardcoded tokens, custom OAuth flows that don't surface `expires_in`). The structured form is the natural fit for resolvers that wrap an OAuth exchange. `fromServiceAccount` uses it internally.

When both `ttlMs` and a structured `expiresIn` are present, the explicit `ttlMs` wins. This matters for tests that want a deliberately-short cache window without breaking the resolver's natural shape.

## Coalescing concurrent calls

Two callers asking for a token simultaneously after the cache expired could race. Each would trigger its own resolver call. `memoizeTtl` coalesces: the first caller starts the resolver, subsequent callers `await` the same in-flight promise.
```ts
// Both calls share one network round trip.
const [a, b] = await Promise.all([resolve(), resolve()]);
```
The in-flight promise is cleared after it resolves (success or failure), so a later call can trigger a fresh refresh.

## Hung resolver timeout

If the resolver hangs (a network blip, a DNS issue, a misbehaving OAuth proxy), every subsequent caller would block forever without a timeout. `memoizeTtl` races the resolver against a 30-second timeout by default:
```ts
memoizeTtl(resolver, { resolverTimeoutMs: 30_000 });
```
When the timeout fires, the in-flight promise rejects, the cache stays empty, and the next call can try again. This means a hung resolver fails one caller; subsequent callers retry rather than join the hung wait.

Tune `resolverTimeoutMs` based on your resolver's expected latency. Service-account exchanges typically complete in 100 to 500 ms; browser ID-token refreshes are similar. The 30-second default is generous enough to cover transient delays without letting a true hang propagate.

## Why this matters for deploys

A Cloud Function deploy can take 60 to 120 seconds end-to-end (upload, build, operation polling). Tokens fetched at the start of that window will be near expiry by the end. Without the 90% rule, the polling phase could hit a 401 and fail the deploy after the function was already built.

The 90% rule combined with per-dispatch resolver calls (F4) means:

- The first primitive in a deploy resolves a fresh token.
- Subsequent primitives within the cache window reuse it cheaply.
- Long deploys that cross the 90% boundary trigger one re-resolve and continue.

The caller never has to think about it.

## When to skip memoisation

A few cases don't need `memoizeTtl`:

- **Browser hosts using `firebaseAuth.currentUser.getIdToken()`.** The Firebase Auth SDK caches and refreshes internally. Calling it on every primitive is cheap.
- **Test fixtures with hardcoded tokens.** Inline a `resolveToken: async () => 'test-token'`.
- **One-shot scripts.** A script that exits after one deploy doesn't benefit from caching; the resolver fires once anyway.

For everything else (long-running processes, deploy bots, CI scripts that run multiple operations), memoisation is on by default through `fromServiceAccount`. Hosts wrapping a raw OAuth flow themselves should wrap their resolver in `memoizeTtl` before constructing a `ProjectScope`.
