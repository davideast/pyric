# Remote Firestore for `pyric-admin` (remote sandbox, slice 2 — design spike)

Status: spike complete — analysis + plan, no implementation.
Scope: `pyric-admin/firestore` gaining a REMOTE dispatch arm — server-side
Node code driving the browser-hosted SharedWorker sandbox's Firestore over
the slice-1 bridge machinery (`worker-op`/`worker-sub` frames,
`connectRemoteSandbox()`'s `RemoteSandboxChannel`). Companion to
`docs/design/remote-sandbox.md` (slice 1: RTDB + Auth) and the parallel
Storage spike (`docs/design/remote-storage.md`).

## Verdict on the architectural fork

**Parallel channel-backed arm — the admin-firestore layer cannot run
unchanged over a remote context.** Same conclusion as slice 1's RTDB/Auth
correction, but for a deeper reason: RTDB/Auth kept WeakMap-local *state*;
admin-firestore's problem is a **synchronous engine seam**. The chainable
admin-compat layer is built directly on `LocalEnvironment`, whose contract
is synchronous end to end, and synchrony cannot span a WebSocket. There is
no narrow async interface to swap an implementation behind — the seam that
exists (`getInternalEnv`) hands back the whole sync engine and explicitly
rejects any sandbox that isn't the in-process `SandboxImpl`.

Evidence chain:

1. **The layering.** `pyric-admin/firestore` is a thin re-export +
   default-app resolver over `pyric/sandbox/admin-firestore`
   (`packages/pyric-admin/src/firestore/index.ts:18`, `:63–73`). The real
   layer is `packages/pyric/src/sandbox/admin-firestore/index.ts`, which
   wraps `pyric/sandbox/admin-compat` =
   `packages/pyric/src/sandbox/firestore/admin-compat/*` (~2.3k lines).

2. **The seam is `LocalEnvironment`, obtained per-op.**
   `buildFirestoreHandle` constructs a fresh compat delegate per call via
   `createCompatFirestore(getInternalEnv(ctx.sandbox), { auth, bypassRules })`
   (`admin-firestore/index.ts:200–201`). `getInternalEnv` **throws
   `invalid-argument` unless `sandbox instanceof SandboxImpl`**
   (`packages/pyric/src/sandbox/internal/sandbox-impl.ts:632–640`) — a
   branded remote handle can never pass it. The sandbox-only methods call
   it directly too (`setRules`/`seed`/`snapshot`,
   `admin-firestore/index.ts:225–240`). `onSnapshot` also reaches for it:
   `getInternalEnv(ctx.sandbox)` then `env.addSnapshotListener(...)`
   (`admin-firestore/index.ts:570–608`).

3. **The consumed `LocalEnvironment` surface is synchronous.** What
   admin-compat actually calls:
   - `env.execute({ method, path, data, auth, merge?, bypassRules })` —
     **sync return** of `OperationResult`
     (`admin-compat/doc-ref.ts:90–104`, `:128`, `:141`, `:152`, `:160`,
     `:171`).
   - `env.getDocument(path)` — **sync existence peek** inside `set()` merge
     dispatch (`doc-ref.ts:126`, `:139`) and, load-bearingly, inside the
     **sync** `WriteBatch.set()` queueing ("the batch path has no async
     wrapping", `admin-compat/batch.ts:45–53`).
   - `env.batch(ops, auth, bypassRules)` — sync (`batch.ts:69–73`).
   - `env.transaction(cb, opts)` where the callback receives a **sync
     `SimTransaction`** — `simTx.get(path)` returns a snapshot
     synchronously and `simTx.getAll(...paths)` registers the read-set
     synchronously (`admin-compat/transaction.ts:65`, `:69`;
     `admin-compat/firestore.ts:115–124`).
   - queries: `env.scanDocuments(collectionPath, { directOnly })`
     (`admin-compat/query.ts:480`), `env.readQueryCandidates(...)`
     (`query.ts:514`), and collection-group scans over `env.snapshot()`
     (`query.ts:847`) — all sync.
   - `env.addSnapshotListener(target, cb, options, auth, onError,
     followsCurrentUser)` (`admin-firestore/index.ts:606–608`).

   The *public* admin surface is mostly async (`get/set/update/delete`,
   `Query.get`, `aggregate`, `commit`, `runTransaction` — all
   Promise-returning, `admin-compat/types.ts:88–96`, `:161–179`, `:218–223`,
   `:226–234`), but three members are irreducibly sync at the API contract:
   `WriteBatch.set/update/delete` chain-queueing (fine — pure local
   buffering, except the `set()` existence peek), `Transaction.set/update/
   delete` (fine — local queueing), and the sandbox-only
   `SandboxFirestore.setRules/seed/snapshot` (`admin-firestore/index.ts:
   161–174` — `LintResult`/map returned synchronously).

4. **Why not async-ify the seam?** Making admin-compat consume an
   `AsyncEnvironment` interface would mean rewriting `execute`-call plumbing
   across doc-ref/query/batch/firestore (~2.3k lines), changing
   `WriteBatch.set`'s sync-peek design, replacing the sync `SimTransaction`
   inside `env.transaction` with a wire transaction (the worker doesn't even
   expose an interactive transaction — see §3), and re-plumbing
   `addSnapshotListener`. The result would still need per-method wire
   translation (sentinels, codec, error shapes). That is strictly more work
   and more risk than a parallel arm, and it perturbs the heavily-tested
   local compat layer (the conformance exemplar) for zero local benefit.

5. **The parallel arm is cheap because it already half-exists.** The worker
   client (`packages/pyric-tools/src/serve/worker/client.ts`) demonstrates
   every needed pattern engine-free: descriptor building (`QueryDescriptor`,
   protocol.ts:91–106), write ops, batch descriptors, the optimistic
   transaction protocol (client.ts:938–1040), snapshot rehydration
   (`deserializeDocData`, client.ts:115–116). And the RTDB remote arm shows
   the pyric-admin-side shape: channel ops with a pinned lens, no local
   state, shared shell between arms
   (`packages/pyric-admin/src/database/index.ts:800–1000`).

So: **implement the admin Firestore SHAPE (`admin-compat/types.ts`
interfaces, re-used verbatim) directly over channel ops**, dispatched on
`isRemoteSandbox(ctx.sandbox)` — the same fork `database/index.ts` took.
The remote arm and the local arm share the type surface and the conformance
suite, not the implementation.

### Where the dispatch lives

Not in `pyric-admin/firestore/index.ts` alone. The current guard there
(`packages/pyric-admin/src/firestore/index.ts:38–45`) only covers
**app-based** resolution (`getFirestore(app)` / `getFirestore()`); the
ctx-form `getFirestore(sandbox.withAuth(...))` with a remote sandbox slips
through to `baseGetFirestore` and dies later with `getInternalEnv`'s
misleading `invalid-argument` ("custom Sandbox implementations are not
supported") on the *first operation* (per-op delegate,
`admin-firestore/index.ts:200`), or immediately on `setRules`.

The brand lives in `pyric` (`packages/pyric/src/sandbox/remote.ts:36`,
guard `:126`) with a structurally-typed loose channel
(`RemoteSandboxChannel`, remote.ts:48–69) *specifically so pyric-side code
can consume it without importing pyric-tools*. Therefore:

- **Dispatch point:** `getFirestore` / `getAdminFirestore` in
  `packages/pyric/src/sandbox/admin-firestore/index.ts` (`:266`, `:324`)
  branch on `isRemoteSandbox(ctx.sandbox)` and return a channel-backed
  `SandboxFirestore`.
- **The remote impl:** a new sibling module, e.g.
  `packages/pyric/src/sandbox/firestore/admin-compat-remote/` implementing
  `admin-compat/types.ts`'s `Firestore`/`DocumentReference`/`Query`/
  `WriteBatch`/`Transaction` over `RemoteSandboxChannel.op/subscribe`,
  spelling ops loosely (`{ method: 'getDoc', path, actAs }`) exactly as
  `pyric-admin/database`'s remote arm does.
- The `pyric-admin/firestore` guard (`index.ts:38–45`) is then deleted —
  app resolution flows into the now-remote-aware base `getFirestore`.

## 2. Worker protocol coverage vs the admin surface

Ops (`packages/pyric-tools/src/serve/worker/protocol.ts:343–435`) all
accept `actAs?: AuthLens` (`:436–444`); handlers in
`packages/pyric-tools/src/serve/worker/host.ts` (`handleOp`, `:558`) resolve
the data handle via `lensDb` (`:385–405`).

| Admin surface (admin-compat/types.ts) | Worker op / sub | Evidence | Status |
|---|---|---|---|
| `doc(path).get()` | `getDoc` | protocol.ts:344; host.ts:572 | covered |
| `doc().set(data, {merge?, mergeFields?})` | `setDoc` (options carried) | protocol.ts:346; host.ts:597 | covered (create-vs-update dispatch happens worker-side via the modular set path — no client peek needed) |
| `doc().update()` / `.delete()` | `updateDoc` / `deleteDoc` | protocol.ts:347–348; host.ts:607/617 | covered |
| `collection().add()` | `addDoc` (worker mints id) | protocol.ts:349; host.ts:626 | covered |
| `Query.get()` incl. where/orderBy/limit/limitToLast/cursors | `getDocs` + `QueryDescriptor` constraints | protocol.ts:345, 98–106; host.ts:581 | covered for simple constraints |
| `Query.applyFilter({kind:'and'/'or'})` (composite filters, types.ts:113–130) | — no composite kind in `QueryConstraintDescriptor` (protocol.ts:98–106 is where/orderBy/limit/cursors only) | | **GAP 1** |
| `startCursorFromSnapshot` / `endCursorFromSnapshot` (types.ts:150–163) | client-side value extraction → plain `startAt`/`endAt` values | protocol.ts:103–106 | covered (resolve snapshot→values locally) |
| `Query.aggregate({count})` | `count` | protocol.ts:350; host.ts:636 | covered |
| `Query.aggregate({sum/average})` (types.ts:188–192) | — only `count` exists | | **GAP 2** |
| `collectionGroup(id)` | `GroupRef` source in `getDocs`/`count` | protocol.ts:80–83 | covered |
| `batch().commit()` | `batchCommit` + `WriteDescriptor[]` | protocol.ts:351, 140–143; host.ts:661 | covered (`set` descriptor carries merge options; no queue-time peek needed) |
| `runTransaction(fn)` | `getDoc` reads + single-shot `txnCommit` (optimistic read-set validation, client retry) | protocol.ts:352, 146–164; host.ts:680–798; client model client.ts:938–1040 | covered — see §3 |
| `onSnapshot(doc/query)` (admin-firestore/index.ts:442–609) | `FirestoreSubMessage` (`t:'sub'`, target + `actAs`) | protocol.ts:451–469; snap value = getDoc/getDocs shape (protocol.ts:576–586) | covered; constraints ride `QueryDescriptor` (same GAP 1 for composite filters) |
| `setRules` (admin-firestore/index.ts:161) | `setFirestoreRules` / `setRules` | protocol.ts:353–354; host.ts:800 | covered (returns lint) — but must become **async** remotely |
| `seed({documents})` (index.ts:168) | — no seed/clear op; composable from `admin.listDocuments` + `admin.deleteDocument` + `admin.setDocument` (protocol.ts:359–361) but non-atomic and chatty | | **GAP 3** (optional op) |
| `snapshot()` (index.ts:174, sync) | `admin.readState` / `getSnapshot` exist but async by nature | protocol.ts:362, 435 | irreducibly sync → **remediating throw**, plus async alternative |
| `FieldValue` sentinels (types.ts:274–290: `{__type:'serverTimestamp'/…}`) | wire `SentinelMarker` `{__sentinel:…}` (protocol.ts:122–127), resolved host-side via `resolveSentinels` → modular factories (host.ts:286–322) | shape mismatch: `__type`+`value` vs `__sentinel`+`n`; sandbox's own capture keys on `__type` (packages/pyric/src/sandbox/firestore/sentinel-capture.ts:55–63) | covered with a **small client-side translation** (§3) |
| Admin `Timestamp` (types.ts:300–358) | JSON leg emits `toJSON()` → `{type:'firestore/timestamp/1.0',…}`; `rehydrateDocValue` recognizes both marker families (packages/pyric/src/firestore-values/index.ts:104–145) | read path fine; write path see **GAP 4** | partial |
| `getFirestore(ctx)` rules-applied identity | `actAs: {mode:'as', uid, token?}` (types.ts:909–911; lensDb host.ts:397–405 honors token claims) | | covered for signed identities |
| `getFirestore(sandbox.withAuth(null))` — explicitly unauthenticated | — absent lens ⇒ **the relay port's session** (`sessionDb`, host.ts:448–466), i.e. the *browser tab's* signed-in user, not "anonymous" | | **GAP 5** |
| `getAdminFirestore` rules bypass | `actAs: {mode:'admin'}` → `pyricGetAdminFirestore` (host.ts:392–394) | | covered |
| `listCollections` (firebase-admin has it; admin-compat does **not** expose it — types.ts:236–256 has no such member) | `listRootCollections`/`listSubcollections` exist anyway (protocol.ts:372–373; host.ts:645/654) | | parity preserved; ops available if the surface ever grows |
| Structured denial context (`SandboxError.denialContext` via `wrapWithErrorTranslation`, admin-firestore/index.ts:274) | `serializeError` flattens to `{code,message}` only (protocol.ts:684–695) | | **GAP 6** (fidelity) |

### Gap list (consolidated)

1. **Composite filters** — `QueryConstraintDescriptor` has no
   `{kind:'filter', filter: Filter}` variant; `or()`/`and()` queries can't
   cross the wire. Additive protocol change.
2. **sum/average aggregates** — only `count` (protocol.ts:350). Add
   `{method:'aggregate', source, spec}` (or extend `count`). Additive.
3. **`seed`** — no atomic seed/clear-documents op. Either add
   `{method:'firestore.seed', documents}` or ship v1 with a composed
   (non-atomic) implementation over `admin.*` ops.
4. **Write-data rehydration host-side** — host write handlers only run
   `resolveSentinels` (host.ts:600, 610, 629, 777–781); they never
   `rehydrateDocValue` the data. Over the WS leg `JSON.stringify` turns a
   Node-side `Timestamp` into its marker (`{type:'firestore/timestamp/1.0'}`
   admin shape, or `{__type:'timestamp'}` rules shape), which the worker
   then **stores as a plain map**: readers rehydrate it back (reads look
   right), but in-worker rules comparisons and `orderBy` over that field
   see a map, not a timestamp. Fix host-side (`rehydrateDocValue` on
   `msg.data` / batch / txn writes) — behavior change only, no wire change.
5. **No "anonymous" lens** — `AuthLens` is `admin | as(uid) | app-session`
   (packages/pyric/src/sandbox/types.ts:909–912). A relayed op with no lens
   resolves to the **browser tab's port session** (host.ts:448–466), so the
   remote arm cannot express `withAuth(null)`. Add `{mode:'anon'}`
   (additive) — without it, remote `getFirestore(sandbox.withAuth(null))`
   silently runs as whoever is signed in in the tab. This is the one gap
   that is a **correctness/security hazard**, not a feature hole.
6. **Denial-context fidelity** — extend `serializeError` to carry an
   optional structured `denialContext` field (additive on `ResMessage.
   error`), so remote `SandboxError`s match local ones.

## 3. Codec fidelity and transactions over the relay

**Doc-data codec survives the WS leg.** Both bridge legs are JSON
(`connectRemoteSandbox` does `ws.send(JSON.stringify(msg))`,
`packages/pyric-tools/src/remote/index.ts:594`; the browser peer relays the
frames into `relayWorkerOp/relayWorkerSub`
(`packages/pyric-tools/src/bridge/client/bridge.ts:216–221`,
`serve/entries/runtime.ts:522–523`). Read-path doc data is already a JSON
string envelope — `SerializedDocData = { json: string }`
(protocol.ts:636–650) — so double JSON encoding is loss-free; the Node side
runs `deserializeDocData` → `rehydrateDocValue`
(protocol.ts:666–668), which is a **leaf module (`pyric/firestore-values`)
that runs fine in Node** (protocol.ts:46–51). Both admin (`type:
'firestore/timestamp/1.0'`) and rules (`__type:'timestamp'`) marker
families rehydrate (firestore-values/index.ts:104–145). One type mismatch
to translate at the arm boundary: `rehydrateDocValue` yields
`pyric/firestore-values`' `Timestamp` (`seconds`/`nanos`), while the admin
surface re-exports admin-compat's `Timestamp` (`seconds`/`nanoseconds`,
types.ts:300) — the remote arm should map rehydrated values into the
admin-compat classes so `instanceof Timestamp` against the `pyric-admin/
firestore` export holds (S — a small value-walk, same shape the client.ts
read-translation does).

**Sentinels resolve host-side for Node-originated writes.** The remote arm
translates admin `FieldValueSentinel` (`{__type:'increment', value}`,
types.ts:274–290) → wire `SentinelMarker` (`{__sentinel:'increment', n}`,
protocol.ts:122–127) while walking write data; `resolveSentinels` on the
host rebuilds real modular sentinels before the write (host.ts:286–322), so
`serverTimestamp()` resolves against the **worker's** clock and
`increment`/`arrayUnion` apply against worker state — correct semantics.
(Sending the `__type` shapes raw would *probably* also work, since the
sandbox detects sentinels by `__type` shape — sentinel-capture.ts:55–63 —
but the `__sentinel` marker is the documented wire contract; translate.)

**Transactions: single-shot commit, multi-roundtrip reads — the correlated
op model is sufficient.** The worker has **no interactive transaction
session**: the protocol is (a) each `txn.get` is an ordinary `getDoc` op
recording `{path, data}` into a client-held read-set (client.ts:40–55,
987–1021), (b) one `txnCommit` op ships `reads + writes`
(protocol.ts:352, 146–164), (c) the host re-reads each path inside a real
sandbox transaction, compares serialized JSON forms, applies writes or
returns `{code:'aborted'}` (host.ts:680–798), (d) the client retries
`updateFn` up to a max-attempt bound (client.ts:949, 1036). Every message
is an independent correlated request/response — exactly what
`RemoteSandboxChannel.op` provides (remote/index.ts:226–257). No worker
state spans ops, so peer replacement mid-transaction just fails one op and
the retry loop re-runs `updateFn` — safe. The 35s Node-side / 30s bridge
timeouts apply per op, not per transaction, so long `updateFn`s are fine.
One semantic note to document: read-set comparison is
serialized-JSON equality computed **worker-side** (host.ts:700–719 relies
on same-process `JSON.stringify` determinism); since the Node arm submits
reads exactly as the worker serialized them (the `SerializedDocData.json`
string, unmodified), determinism holds — the arm must keep the *original*
json strings in its read-set, never re-serialize rehydrated data.

`TransactionImpl`-shape queueing (`tx.set/update/delete` return `this`
synchronously) maps to local descriptor buffering — no wire interaction
until commit. `tx.get(query)` mirrors client behavior: run `getDocs`, then
record each returned doc path + serialized data into the read-set
(the worker-side commit re-reads them; matches admin-compat's
`simTx.getAll` registration, transaction.ts:53–67).

## 4. Plan

### Architecture (from §1)

- New `packages/pyric/src/sandbox/firestore/admin-compat-remote/`:
  channel-backed implementations of `Firestore`, `DocumentReference`,
  `CollectionReference`/`Query` (descriptor-building, mirrors
  client.ts:251–265), `WriteBatch`, `Transaction` (optimistic model above),
  plus `onSnapshot` routing to `channel.subscribe` with a
  `FirestoreSubMessage` payload. All ops pin the lens derived from the
  handle: `getAdminFirestore` → `{mode:'admin'}`; `getFirestore(ctx)` with
  `ctx.auth = {uid, token?}` → `{mode:'as', uid, token}`;
  `ctx.auth === null` → `{mode:'anon'}` (new lens, GAP 5) — never omit
  `actAs` (an absent lens silently adopts the browser tab's session).
- Dispatch in `pyric/sandbox/admin-firestore`'s `getFirestore` /
  `getAdminFirestore` (index.ts:266, :324) on `isRemoteSandbox(ctx.sandbox)`;
  `onSnapshot` (index.ts:501) branches before `getInternalEnv`.
  Error translation: reuse `wrapWithErrorTranslation` where possible;
  wire errors (`{code,message}` + optional denialContext per GAP 6) map to
  `SandboxError`.
- Delete the guard at `packages/pyric-admin/src/firestore/index.ts:38–45`.

### Remediating throws (can't work remotely)

- `SandboxFirestore.snapshot()` — sync map return; throw
  `unimplemented` with "use `channel.op({method:'admin.readState'})` or
  Studio" (matches the slice-1 handle's `admin`/`snapshot` throws,
  remote/index.ts:494–510).
- `setRules` / `seed` — sync `LintResult` returns. Options: (a) throw with
  guidance toward async channel ops (`setFirestoreRules` exists), or
  (b) pre-npm, loosen the `SandboxFirestore` signature to
  `LintResult | Promise<LintResult>` so the remote arm can be async.
  Recommend (b) for `setRules` (test ergonomics depend on it) and (a)+GAP-3
  op for `seed`.
- The `FOLLOWS_CURRENT_USER` live-listener mode (index.ts:120) — remote
  handles have no `currentUser` mirror in slice 2; frozen-identity only
  (the marker is stamped by the modular browser layer, which never runs in
  Node — non-issue in practice, throw defensively if seen).

### Protocol changes to land BEFORE npm publish freezes the wire (public-alpha — additive, but cheap now, migration-noise later)

1. `{mode:'anon'}` `AuthLens` variant + `lensDb`/`lensRtdb`/sub handling
   (types.ts:909; host.ts:385, :479, :558–562). **The must-do.**
2. Composite-filter constraint descriptor (GAP 1).
3. `aggregate` op for sum/average (GAP 2).
4. `serializeError` structured `denialContext` passthrough (GAP 6).
5. Host-side `rehydrateDocValue` on write data (GAP 4 — host behavior, not
   wire shape, but it defines observable stored-data semantics; fix before
   external SDKs depend on the buggy form).
6. Optional: `firestore.seed` op (GAP 3).

### Work items

| # | Item | Files | Effort |
|---|---|---|---|
| 1 | `{mode:'anon'}` lens end-to-end (type, lensDb/lensRtdb/sub paths, provenance) | `pyric/src/sandbox/types.ts`, `pyric-tools/src/serve/worker/host.ts` | S |
| 2 | Protocol additions: composite filter descriptor, `aggregate` op, error denialContext | `pyric-tools/src/serve/worker/protocol.ts`, `host.ts` | M |
| 3 | Host write-data rehydration (`setDoc`/`updateDoc`/`addDoc`/batch/txn) + tests | `pyric-tools/src/serve/worker/host.ts` | S |
| 4 | Remote refs + one-shot ops: `FirestoreImpl`/`DocumentRefImpl`/query descriptor builder, sentinel `__type`→`__sentinel` walk, read-value admin-class mapping | new `pyric/src/sandbox/firestore/admin-compat-remote/` | M |
| 5 | Remote `WriteBatch` + `Transaction` (optimistic read-set, retry loop, original-json read-set invariant) | same | M |
| 6 | Remote `onSnapshot` (doc + query targets, actAs pinned, `__error` snap → onError, options normalization shared with local impl) | same + `pyric/src/sandbox/admin-firestore/index.ts` | M |
| 7 | Dispatch + error translation + remediating throws (`getFirestore`/`getAdminFirestore`/`onSnapshot` brand branch; async `setRules`; delete the pyric-admin guard) | `pyric/src/sandbox/admin-firestore/index.ts`, `pyric-admin/src/firestore/index.ts` | S |
| 8 | Conformance: run the existing pyric-admin firestore suites against a remote-branded handle on the headless harness | `packages/pyric-admin/test/remote/` (extend `remote-dispatch.test.ts`'s harness), reuse `packages/pyric-admin/test/firestore/*` expectations | M |
| 9 | Docs + `seed` decision (op vs composed vs throw) | protocol.ts, design docs | S |

**Total: L — roughly 6–9 focused days**, dominated by items 4–6 and 8.
(Slice 1 was M/3–5 days; Firestore's surface is ~3× RTDB's.)

### Test plan (headless harness — no browser, no WS)

The pattern is already proven twice: `packages/pyric-tools/test/bridge/
worker-relay.test.ts` (checkpoint 1) and `packages/pyric-admin/test/remote/
remote-dispatch.test.ts` (checkpoint 2) run the REAL worker host
(`handleMessage` + fake ports) behind the REAL bridge core + consumer
session, fronted by the EXACT handle `createRemoteSandboxHandle` builds
(remote-dispatch.test.ts:1–56). Extend it:

1. **Op-level round-trips:** get/set/update/delete/add, merge/mergeFields,
   sentinel resolution (assert worker-side stored value via an independent
   direct port — serverTimestamp resolves, increment applies), Timestamp/
   Bytes/LatLng write→read fidelity across the JSON leg (this is the test
   that catches GAP 4).
2. **Queries:** constraints incl. cursors, collectionGroup, composite
   filters (post GAP-1), aggregates (post GAP-2), rules-applied vs admin
   lens vs `anon` lens (a signed-in port session must NOT leak into a
   `withAuth(null)` handle — the GAP-5 regression test).
3. **Batch + transaction:** atomicity, `already-exists`, read-set conflict
   (interleave a direct-port write between remote `txn.get` and commit →
   assert one retry), retry exhaustion.
4. **onSnapshot:** initial + update + unsub; establishment `__error` →
   onError; peer-replacement resubscribe (bridge re-issues subs — note:
   Firestore snap subs are last-value-wins like RTDB value subs, so replay
   is cursor-free and safe).
5. **Conformance:** the compat-model pattern — run
   `packages/pyric-admin/test/firestore/` suites (admin.test.ts,
   on-denial.test.ts, scenarios/) parameterized over {local sandbox,
   remote-branded handle}; same assertions must pass on both arms.
6. **One manual end-to-end** against real `pyric dev --bridge` + tab before
   calling it done (Node write visible live in Studio; Studio write visible
   to a Node `onSnapshot`).

## Risks

1. **Silent identity leak without the `anon` lens (GAP 5).** An unlensed
   relayed op runs as the browser tab's signed-in session. Any remote arm
   shipped before the lens exists would make `withAuth(null)` mean
   "whoever the developer happens to be signed in as". Land item 1 first.
2. **Write-data fidelity (GAP 4)** — pre-existing host behavior, but the
   remote arm makes it reachable from Node in one line. Reads mask it
   (rehydration on read), so it would ship unnoticed and surface as
   "orderBy on my timestamp field is wrong". Characterization-test it.
3. **Two implementations of one surface.** The parallel arm can drift from
   admin-compat semantics (set-as-create-vs-update, denial codes, aggregate
   NaN handling, query value-ordering). Mitigation is the parameterized
   conformance suite (item 8) — the same oracle, two backends, per the
   compat model.
4. **Read-set determinism invariant** (§3): if the remote transaction ever
   re-serializes rehydrated data instead of echoing the worker's original
   `json` strings, cross-process key-order differences would cause phantom
   aborts (livelock under retry). Encode the invariant in a test.
5. **Behavioral upgrade = behavioral change** (same as slice 1): remote
   Firestore ops emit real sandbox events and wake app listeners; the local
   in-process arm's ops already do too (Firestore rides the env fan-out) —
   so unlike RTDB, the two arms *agree* here. Lower risk than slice 1.
6. **Sub backpressure:** Firestore query snaps can be large (full doc list
   per fire, protocol.ts:576–586) but are last-value-wins per subId —
   the slice-1 coalescing design applies unchanged. The unified event
   stream remains deferred.
