# `pyric/firestore` — maintainer notes

Moved verbatim out of `registry/firestore.ts`. Not part of the site.

## Offline / persistence / network family

`enableIndexedDbPersistence`, `enableMultiTabIndexedDbPersistence`,
`clearIndexedDbPersistence`, `enableNetwork`, `disableNetwork`, and
`waitForPendingWrites` are exported by the sandbox mirror so unchanged
application initialization code can run after package resolution selects
Pyric.

**Honest-mirror rationale**: the sandbox is the backend, running
local-first with persistence on by default. There is no separate cache tier
to opt into and no network to gate. Each function resolves because its
promise is already true or is a documented no-op because the concept has no
local meaning. `disableNetwork` does not simulate an offline queue.

`terminate` maps to `Sandbox.dispose()` and therefore tears down the whole
sandbox rather than a Firestore-only slice. Production never enters these
implementations; inactive package resolution leaves Firebase unchanged.


## Tier-1 cache-init + get-from-* family

`initializeFirestore`, the cache-factory tokens, the explicit cache/server
read variants, `setLogLevel`, and `onSnapshotsInSync` are exported from the
sandbox mirror so canonical application code remains import-compatible.

These are honest sandbox mappings, not production forwarding. Cache settings
are inert because persistence is already local; cache and server read variants
share the authoritative local read path; `setLogLevel` is a no-op; and
`onSnapshotsInSync` approximates local delivery settle. Inactive package
resolution leaves Firebase's production implementations unchanged.


## Evidence and remaining gaps

Frozen production observations remain the answer key for error identity, auto-id format, aggregates, listener metadata, scalar round trips, and equality semantics. This repair does not edit those observations or change any row status or coverage number.

The principal documented divergences remain error class identity, auto-id format, index validation, aggregate cost, listener metadata, transaction contention, and structural `queryEqual`.

The Firestore unit suite covers the sandbox surface. Canonical Node-register and Vite tests cover package selection, while the compiled-isolation test proves the sandbox artifact has no `firebase/firestore` dependency.
