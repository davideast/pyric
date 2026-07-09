# Remote Storage for `pyric-admin` (slice 2 design spike)

Status: spike complete — analysis + plan, no implementation.
Scope: a REMOTE dispatch arm for `pyric-admin/storage` — server-side Node
code driving the browser-hosted SharedWorker sandbox's Storage over the
slice-1 bridge machinery (`connectRemoteSandbox` → `RemoteSandboxChannel` →
`worker-op` frames → SharedWorker host). This replaces the guard at
`packages/pyric-admin/src/storage/index.ts:198–204`
("Storage is not yet supported on a remote sandbox").

## Feasibility verdict

**Feasible, smaller than slice 1.** All the slice-1 transport machinery
(bridge frames, browser relay, `RemoteSandboxChannel`, brand dispatch in
pyric-admin) is reusable unchanged — the `worker-op` relay is
payload-agnostic JSON, so **no bridge-protocol changes are needed**. Two
real gaps:

1. **The worker protocol is read-only for storage.** Only
   `storage.listAll` / `storage.getMetadata` / `storage.getBlob` exist
   (`serve/worker/protocol.ts:407–409`). The admin surface needs write
   ops (`putBytes`, `deleteObject`) and a JSON-safe read op.
2. **Binary does NOT survive the WS legs today** — the key unknown,
   answered: bytes cross the MessagePort by structured clone (fine), but
   both WS legs are `JSON.stringify` (`bridge/client/bridge.ts:168`,
   `remote/index.ts:594`), which **silently corrupts** binary
   (`Blob` → `{}`, `ArrayBuffer` → `{}`, `Uint8Array` → `{"0":…}` index
   object). Nothing rejects; the far side just receives garbage. The fix
   is **base64 fields inside the new storage op payloads themselves**
   (worker-protocol level), so one encoding works verbatim over
   MessagePort and WS with zero relay special-casing.

A third, smaller gap: storage ops carry no `actAs` lens and `pyric/storage`
has no rules-bypass admin plane — the admin arm needs one (small, pre-npm).

Total estimate: **M — roughly 2–3 focused days.**

## 1. The admin storage surface today

`packages/pyric-admin/src/storage/index.ts`:

- **Dispatch**: `getStorage(app)` (line 193) reads the `ADMIN_APP_TARGET`
  brand; the sandbox arm currently guards remote handles with a throw
  (lines 198–204 — the thing this slice replaces) and otherwise calls
  `getSandboxStorage(app)` (line 292). Prod arm delegates to
  `firebase-admin/storage` unchanged (line 231).
- **State**: process-local `WeakMap<Sandbox, BucketMap>` (`SANDBOX_STATE`,
  line 261) — `Map<bucketName, Map<path, FileEntry>>` — plus a
  `sandbox.onEvent` reset hook (lines 270–290). Same pattern (and same
  remote hazard) as the pre-slice-1 RTDB/Auth backends: keying local state
  off a remote handle would create a private server-side store the browser
  never sees, and the `onEvent` hook would throw on a remote handle
  immediately. The remote arm must keep **no local state**.
- **Shapes**: `Storage.bucket(name?)` → `Bucket` (line 65/80),
  `Bucket.file(path)` → `File` (line 97). `File` methods on the LOCAL
  sandbox arm (`SandboxFile`, line 329):

  | Member | Behavior | Evidence |
  |---|---|---|
  | `save(data, opts?)` | `Buffer \| string \| Uint8Array`, replaces content; `resumable: true` throws | 336–353 (throw 340–344) |
  | `download()` | `[Buffer]`; missing → throws `No such object: <bucket>/<path>` | 355–365 |
  | `delete()` | idempotent (missing = no-op) | 367–369 |
  | `exists()` | `[boolean]` | 371–373 |
  | `getSignedUrl(opts)` | deterministic local stub `pyric-sandbox-storage://<bucket>/<path>?expires=…&action=…` — never served | 375–379 |
  | `createWriteStream` / `createReadStream` | throw "not implemented in … sandbox backend" | 384–396 |

  No `list`/`getFiles`, no `getMetadata`/`setMetadata` on `File`, no signed
  cookies/IAM/ACL/copy/move (module header, lines 30–36).

- **First user's typical server code** (unchanged by this slice):

  ```ts
  const app = initializeApp({ sandbox: remoteSandbox() });   // or connectRemoteSandbox()
  const bucket = getStorage(app).bucket();
  await bucket.file('reports/run-1.json').save(buf, { contentType: 'application/json' });
  const [bytes] = await bucket.file('uploads/avatar.png').download();
  const [ok] = await bucket.file('uploads/avatar.png').exists();
  await bucket.file('tmp/scratch').delete();
  ```

## 2. Worker protocol coverage vs. the admin surface

What exists (Studio's "data browse" is read-only):

| Op | Handler | Notes |
|---|---|---|
| `storage.listAll` | `host.ts:1061–1072` | returns `{ items, prefixes }` of `{ fullPath, name }` — plain JSON |
| `storage.getMetadata` | `host.ts:1074–1081` | `FullMetadata`, plain JSON |
| `storage.getBlob` | `host.ts:1083–1089` | **returns a `Blob`** — MessagePort-only; corrupts over WS |

Declared at `serve/worker/protocol.ts:407–409`. None carry `actAs` (unlike
every RTDB op). The host reads through `pyric/storage` with a bare-sandbox
(anonymous) context: `ensureStorage` at `host.ts:499–503` does
`getStorage(initializeApp({ sandbox: ctx.sandbox }))`, and `pyric/storage`
evaluates rules (when configured) against `target.context.auth`
(`upload.ts:71`, `download.ts:85`, `enforce.ts:27–36`; open-by-default when
no rules — `getStorageSandbox` options honored first-call-per-sandbox,
`service.ts:137` `SERVICES` WeakMap). Note the worker's store is the SAME
store the page uses in worker mode — one IndexedDB-backed
`StorageService` per `Sandbox` — and uploads emit `service_mutation`
sandbox events (`upload.ts:86`), so server writes get Studio provenance
for free, same as RTDB in slice 1.

**Missing vs. the admin surface from §1:**

| Admin need | Worker op today | Gap |
|---|---|---|
| `file.save` | — (browser entry throws too: `serve/entries/storage.ts:62`, `uploadBytes` unsupported in worker mode) | new `storage.putBytes` |
| `file.download` | `storage.getBlob` — Blob corrupts over WS | new JSON-safe `storage.getBytes` (base64) |
| `file.delete` | — (`entries/storage.ts:65` throws in worker mode) | new `storage.deleteObject` |
| `file.exists` | `storage.getMetadata` (map not-found → false) | none — reuse |
| `file.getSignedUrl` | n/a | none — stays a **local** stub (deterministic string, no data needed) |
| admin/rules-bypass identity | RTDB ops have `actAs` (`protocol.ts:443`); storage ops have none | add `actAs` to storage ops + a bypass path in `pyric/storage` |

Pleasant side effect: adding write ops also unblocks the browser entry's
worker-mode `uploadBytes`/`getBytes`/`deleteObject`
(`entries/storage.ts:51–66` currently throw "not supported over the pyric
SharedWorker yet").

## 3. Binary payloads over the relay — the key unknown, answered

**Today's paths:**

- Worker host → page: `ok(port, msg.id, blob)` posts a `Blob`
  (`host.ts:1086`) — structured clone over the `MessagePort`, lossless.
  The Studio client consumes it directly (`worker/client.ts:1984–1990`).
- Node ↔ bridge ↔ browser: both WS legs are JSON.
  Browser peer: `ws.send(JSON.stringify(msg))`
  (`bridge/client/bridge.ts:168`); server peer adapter:
  `ws.send(JSON.stringify(out))` (`bridge/server/peer.ts:46,62`); Node
  client: `ws.send(JSON.stringify(msg))` (`remote/index.ts:594`).

**Would the slice-1 relay corrupt or reject an ArrayBuffer today?**
Corrupt, silently. `handleWorkerOp` forwards `req.op` verbatim into the
worker and `send`s the result (`bridge/client/bridge.ts:282–298`) — no
type check anywhere. `JSON.stringify` turns `ArrayBuffer`/`Blob` into `{}`
and `Uint8Array`/`Buffer` into an index-keyed plain object
(`{"0":137,"1":80,…}` — Buffer becomes `{type:'Buffer',data:[…]}`, which
"works" but is ~4–5x the bytes and an accidental wire format). Nothing
errors; a relayed `storage.getBlob` from Node would resolve to `{}`.

**The fix — encoding lands in the WORKER protocol, not the bridge:**

- New storage ops carry bytes as **base64 strings inside the op
  payload/result** (`dataB64` fields). One representation, valid JSON,
  travels identically over MessagePort and both WS legs; the bridge
  protocol, browser relay, and `RemoteSandboxChannel` need **zero
  changes** (they are already payload-agnostic). Base64 over MessagePort
  is a minor efficiency loss for the (future) in-browser callers of these
  ops — acceptable; Studio keeps using `storage.getBlob` for its own
  reads.
- **Size cap**: enforce `MAX_STORAGE_OP_BYTES` (proposed **8 MiB raw**,
  ~11 MiB base64 — comfortably under `ws`'s 100 MiB default `maxPayload`;
  the bridge sets none, `serve/bridge-mount.ts:170`) at BOTH ends: the
  Node conveniences reject before sending (`payload-too-large`, message
  naming the cap and pointing at streams-unsupported), and the worker host
  rejects oversized `putBytes`/`getBytes` results so a big browser-side
  object can't blow up the relay. Whole-payload buffering is inherent —
  streams/resumable stay unsupported (they throw on the local arm too).
- Non-goal: WS binary frames / structured-clone-over-WS. The uniform-JSON
  wire ("auditable with a single parser", `bridge/protocol.ts:62–64`) is a
  deliberate property; base64-in-payload preserves it. Revisit only if
  large-object throughput becomes a real requirement.
- Hygiene follow-up (S): the relay could refuse to serialize a `worker-res`
  whose value fails a JSON round-trip sanity check, turning future silent
  corruption (e.g. someone relaying `storage.getBlob`) into a loud error.
  Optional; the remote conveniences simply never call `getBlob`.

## 4. The dispatch arm plan (mirroring `database/index.ts`'s remote arm)

**New/changed worker ops** (`serve/worker/protocol.ts`, handlers in
`host.ts` next to `storage.*` at 1061; all gain `actAs?: AuthLens` like the
RTDB ops at `protocol.ts:443`):

| Admin member | Worker op | Payload → result |
|---|---|---|
| `file.save(data, opts)` | `storage.putBytes` (new) | `{ path, dataB64, contentType?, metadata?, actAs }` → `FullMetadata` |
| `file.download()` | `storage.getBytes` (new) | `{ path, actAs }` → `{ dataB64, contentType, size }` |
| `file.delete()` | `storage.deleteObject` (new) | `{ path, actAs }` → `void`; remote arm swallows `storage/object-not-found` to preserve the local arm's idempotent delete (`storage/index.ts:367`; `pyric/storage`'s `deleteObject` throws on missing, `download.ts:69–74`) |
| `file.exists()` | `storage.getMetadata` (existing, + actAs) | not-found → `[false]` |
| `file.getSignedUrl()` | none — local stub | same string as `storage/index.ts:375–379`, byte-for-byte |

**Identity/actAs pinning**: every relayed op pins
`actAs: { mode: 'admin' }`, exactly like the RTDB remote arm's
`REMOTE_ADMIN_LENS` (`database/index.ts:814–815`). The host maps the admin
lens to a rules-bypass path. Since `pyric/storage` has no bypass today
(rules always evaluate against `target.context.auth` when configured), add
one in `pyric/storage` — smallest shape: internal admin variants (or an
`admin: true` service flag on a host-only context) exported via an
internal subpath, mirroring how `lensRtdb` gives RTDB its bypass handle
(`host.ts:479`). Non-admin lenses (`{ mode: 'as', uid }`) can be supported
in the same change by constructing `getStorageSandbox(ctx.sandbox.withAuth(lensAuth))`
contexts, but only the admin lens is required for this slice.

**pyric-admin remote arm** (`packages/pyric-admin/src/storage/index.ts`,
replacing the guard at 198–204): dispatch order matches auth
(`auth/index.ts:892–897` — remote brand checked BEFORE the local arm, since
the local arm's `WeakMap` + `onEvent` hook must never touch a remote
handle). `getRemoteStorage(sandbox)` keeps a
`WeakMap<Sandbox, Storage>` of handles only (no data — same as
`remoteDbBySandbox`, `database/index.ts:838`) and builds
`Storage`/`Bucket`/`File` objects whose data methods relay
`sandbox.channel.op(...)` (the structurally-typed channel from
`pyric/sandbox/remote.ts:48–69`; brand check via `isRemoteSandbox`,
`remote.ts:126`, already imported at `storage/index.ts:43`).

**Remediating throws on the remote arm:**

- `createWriteStream` / `createReadStream` — keep throwing; upgrade the
  message to name the remote context and the buffer-based alternative
  (`save`/`download`).
- `save(..., { resumable: true })` — throw, parity with local (line 340).
- payloads over the size cap — `payload-too-large` with the cap in the
  message.
- **Non-default bucket names — throw** (new divergence, must be explicit):
  the local arm has real multi-bucket isolation (`BucketMap`), but
  `pyric/storage`'s worker store is single-bucket ("the data store is
  shared", `service.ts:100–106` bucket option doc). Faithful relaying is
  impossible; a remediating throw on `storage.bucket('non-default')`
  ("the browser sandbox has a single bucket — use the default bucket")
  beats silently merging buckets. The first user's flow uses the default
  bucket.
- `getSignedUrl` does NOT throw — local stub, identical output to the
  local arm.

**Test plan** (pattern: `packages/pyric-admin/test/remote/remote-dispatch.test.ts`
— real worker host `handleMessage` + fake ports behind the real bridge core
and the EXACT production handle from `createRemoteSandboxHandle`, no
browser/WS):

1. New `packages/pyric-admin/test/remote/remote-storage.test.ts` reusing
   that harness verbatim, plus `import 'fake-indexeddb/auto'` (the storage
   backend is IndexedDB, `storage/persistence.ts:154–158`; pyric's own
   storage tests already run headless this way,
   `packages/pyric/test/storage/persistence.test.ts:13`). Coverage:
   - save → download round-trip of **non-UTF8 binary** (e.g. PNG-magic
     bytes + 0x00/0xFF runs) — the corruption regression test; assert
     byte equality through a full JSON.stringify/parse of every frame
     (the harness should round-trip frames through JSON to model the WS
     legs, which the slice-1 harness's in-process pipe does not).
   - exists()/delete()/idempotent re-delete; `No such object` on missing
     download (message parity with local arm, line 361).
   - contentType/metadata round-trip via save options.
   - cross-visibility: write via an independent direct worker port
     (`storage.getBytes`), read via admin `download()` — one shared store.
   - size-cap rejection; resumable/stream/non-default-bucket throws;
     no-peer "open <serve url>" error surfacing through `file.save`.
   - the local in-process arm still selected for plain sandboxes.
2. Worker-host op tests beside `pyric-tools/test/serve/worker/host.test.ts`:
   `putBytes`/`getBytes`/`deleteObject` handlers incl. admin-lens bypass
   with deny-all rules configured, and the anonymous lens still enforcing.
3. Conformance: run the local-arm storage assertions against the remote
   arm (one oracle, two backends — same pattern as slice 1's step 3).
4. One manual end-to-end against real `pyric dev --bridge` + tab (uploads
   visible in Studio's storage browser).

## 5. Work items

| # | Work item | Files | Effort |
|---|---|---|---|
| **Worker/bridge** | | | |
| 1 | Ops `storage.putBytes`/`storage.getBytes`/`storage.deleteObject` + `actAs` on all storage ops; `MAX_STORAGE_OP_BYTES` const | `pyric-tools/src/serve/worker/protocol.ts` | S |
| 2 | Host handlers + admin-lens storage path (rules bypass) | `pyric-tools/src/serve/worker/host.ts`; small internal export in `pyric/src/storage/` (upload/download/enforce or a service flag) | M |
| 3 | Bridge protocol / relay changes | **none** (payload-agnostic JSON; base64 rides inside op payloads) | — |
| 4 | (Optional) unblock worker-mode browser entry: `uploadBytes`/`getBytes`/`deleteObject` via the new ops | `pyric-tools/src/serve/worker/client.ts`, `src/serve/entries/storage.ts` | S (optional) |
| **Remote client conveniences** | | | |
| 5 | `RemoteStorage` conveniences (putBytes/getBytes/delete/getMetadata/listAll; base64 helpers; admin lens pinned; client-side size cap) on the handle, beside `buildRemoteRtdb` (`remote/index.ts:358`) | `pyric-tools/src/remote/index.ts` | S |
| **pyric-admin dispatch arm** | | | |
| 6 | Replace the guard (198–204) with `getRemoteStorage`: remote `Storage`/`Bucket`/`File` over `sandbox.channel`; remediating throws (streams/resumable/non-default bucket/size cap); local `getSignedUrl` stub; idempotent delete mapping | `pyric-admin/src/storage/index.ts` | M |
| **Tests** | | | |
| 7 | `remote-storage.test.ts` (harness + fake-indexeddb + JSON-round-trip frames) + conformance vs local arm | `pyric-admin/test/remote/remote-storage.test.ts` | M |
| 8 | Worker-host storage-op + lens tests | `pyric-tools/test/serve/worker/` | S |

**Total: M — ~2–3 focused days**, dominated by items 2, 6, 7.

## Risks

1. **Silent binary corruption is the failure mode, not rejection** —
   already live: relaying `storage.getBlob` through the slice-1 channel
   today yields `{}` with no error. The base64 ops fix the admin path, but
   nothing stops a future caller relaying `getBlob`; consider the item-3
   hygiene guard (JSON-round-trip check in the relay) as cheap insurance.
2. **`pyric/storage` grows an admin plane** — the rules-bypass touches a
   package outside pyric-tools/pyric-admin; keep it internal-subpath-only
   so the public modular surface stays rules-honest. Pre-npm, cheap now.
3. **Local vs. remote arm divergence** (slice-1 risk 2, again): local =
   in-memory multi-bucket Map, no rules, no events; remote = worker's
   IndexedDB store, rules-evaluated (bypassed via admin lens), emits
   events, single bucket. The non-default-bucket throw makes the sharpest
   divergence loud; consider the same follow-up as RTDB — rewire the local
   admin arm onto `pyric/storage`'s sandbox backend so both arms share one
   store and one event story.
4. **Memory/size semantics**: whole-object buffering + base64 (+33%) on
   four hops. The 8 MiB cap keeps it sane; document that big-file flows
   need the (unshipped) streaming story rather than raising the cap.
5. **Rules interaction with page-configured rules**: the worker's storage
   service is first-call-wins per sandbox (`service.ts:137`); if the page
   configured deny-y rules, the admin lens must genuinely bypass them —
   test 2's deny-all case pins this.
