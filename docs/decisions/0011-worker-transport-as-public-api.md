# 0011: The SharedWorker transport as a versioned public API

Status: Proposed; extends ADR-0005

Date: 2026-07-22

## Context

`packages/cli/src/serve/worker/` (~10,170 lines) is the transport that hosts the
one shared sandbox in a SharedWorker and mirrors the Firebase modular SDK for
every tab on an origin. It is split into two symmetric trees — `client/` runs in
the page, `host/` runs in the worker — and is published as the
`@pyric/cli/serve/worker` subpath. It is the most load-bearing seam in the
served product: every read, write, listener, and auth transition for the app,
Studio, the bridge, and the remote `pyric-admin` arm crosses it.

An architecture review framed it against one question: what would this code look
like if it were held to the standard of a public API? The review found that the
dispatcher is already a deep, well-pinned seam — `handleMessage(ctx, port, msg)`
is driven directly by 39 test files against a real sandbox and fake ports — but
the *contract that crosses it* is spelled out by hand rather than described by
the code:

- `protocol.ts` (1,130 lines) is one discriminated union carrying all 74 op
  methods for every service family, plus five serialization helpers. It is the
  coupling hub 34 files import.
- The 74-method routable surface lives in three lockstep lists that must move
  together: the `OpMessage` union, the `isFirestoreWriteOp / isAuthOp / …`
  predicate cascade the host walks, and a *frozen* `ROUTABLE_METHODS` table in
  `dispatch-table.test.ts` that asserts the count is exactly 74. That test
  exists only because routing is a switch rather than a computed table.
- Every op reply is `{ t:'res', … value: unknown }`. The real reply shapes live
  in a prose comment above `ResMessage` and are re-declared as `as { … }` casts
  at ~74 client call sites. The request-to-response pairing appears nowhere in
  the types.
- There is no named front door and no protocol version: families import a loose
  kit (`rpc`, `dataRpc`, `openSnapshotSubscription`) and hand-build 100+ raw op
  literals; the "handshake" is two rival methods (`getRuntimeEpoch` for
  staleness, `getVersion` for instance id) bolted on after the fact.

ADR-0005 accepted a per-family *type* split as a follow-up but deliberately kept
"one authoritative discriminated union" and did not settle dispatch, typing, the
front door, or versioning. This ADR settles the target design for all four. It
is a design plan, not an implemented change; the migration in Decision 7 is
sequenced but unstarted.

The design is held to two further goals beyond public-API form. It must improve
code health at the level a reviewer feels line by line — no large files, no
large handlers, no unnamed condition buried inside an `if` or a ternary — and it
must let many PRs land in parallel without drowning contributors in merge
conflicts. These are not separate cleanup projects bolted onto the API work:
the record architecture is what produces them. Decisions 9 and 10 make both
goals explicit and enforceable so a later review can decide them mechanically
rather than by taste.

## Decisions

1. **Name the compatibility boundary — and it is not client-to-host.** This is
   the load-bearing decision; the rest serve it. The client and host ship in one
   npm version, and ADR-0008 records that these internal modules are "not a
   compatibility surface to preserve." So the client-to-host wire may change
   freely, in lockstep, within a version. The genuine cross-version wire
   boundaries are two: (a) a retired-but-still-running worker serving an older
   wire to a freshly-loaded client (the `retireRuntime` / epoch /
   `runtime-reload` machinery exists for exactly this), and (b) the bridge and
   remote-sandbox relay to `pyric-admin`, where a Node peer speaks the wire
   across a separately-released package. Public-API rigor — version negotiation,
   additive-only frames, tolerant decode of unknown fields — applies at those
   two boundaries and nowhere else. Adopting the *form* of a public API
   everywhere while taking on its *obligations* only here is the whole point of
   the reframing. Applying full semantic-versioning ceremony to the internal
   client-to-host contract was rejected: there is no external consumer of it, and
   the ceremony would fight the repository's stated freedom to restructure
   just-in-time.

2. **One operation is one record; dispatch is computed.** Each op becomes a
   self-describing `OperationSpec` colocated with its family, and the dispatcher
   derives its routing table by reading the registry once — the data-record
   convention (code-conventions section 6, "append-friendly structures are
   per-record, not per-list") applied to the transport.

   ```ts
   interface OperationSpec<Req, Res> {
     readonly method: string;              // the wire discriminant, declared once
     readonly surface: Surface;            // firestore | auth | rtdb | storage | …
     readonly request: Codec<Req>;         // wire ⇄ value for the request
     readonly response: Codec<Res>;        // wire ⇄ value for the reply
     handle(ctx: HostCtx, port: PortLike, req: Req): Promise<Res>;
   }

   // one file per operation; the directory is the index (no hand-kept list)
   export const addDoc = defineOp('addDoc', {
     surface: 'firestore',
     request:  t.object({ collectionPath: t.string, data: t.docData }),
     response: t.object({ id: t.string, path: t.string }),
     handle: (ctx, _port, req) => ctx.writes.addDoc(req.collectionPath, req.data),
   });

   // the routing table is computed, not switched
   const REGISTRY: ReadonlyMap<string, OperationSpec<any, any>> =
     indexBy(op => op.method, discoverOps());
   ```

   Keeping the central union plus the `isXxxOp` cascade (ADR-0005's minimal
   split) was rejected: it leaves the three-list lockstep in place and keeps the
   frozen-count test as the conflict generator a new operation must edit.

3. **Request and response are typed together; `res.value` stops being
   `unknown`.** The `OperationSpec` binds `Req` to `Res`, so the client's front
   door is typed end to end and the host handler is checked against the same
   map. The prose "value shapes by method" comment becomes the type.

   ```ts
   type OpName            = keyof Registry;
   type Req<Op extends OpName> = Registry[Op] extends OperationSpec<infer R, any> ? R : never;
   type Res<Op extends OpName> = Registry[Op] extends OperationSpec<any, infer R> ? R : never;
   ```

   Runtime schema validation without static types was rejected: it would catch
   drift at the boundary but lose the compile-time guarantee that a client
   sender and its host handler agree, which is the property that makes the
   client-to-host contract safe to change in lockstep (Decision 1).

4. **A named front door: `WorkerTransport` (client) and `WorkerHost` (host).**
   Families depend on a small interface, not on the correlation maps and raw
   frames. The `_pending` / `_snapSubs` / `_eventSubs` registries, the Studio
   lens/issuer stamping, and the disconnect bookkeeping all move behind it.

   ```ts
   interface WorkerTransport {
     call<Op extends OpName>(op: Op, req: Req<Op>): Promise<Res<Op>>;
     subscribe<T extends Target>(target: T, onNext: (v: Snap<T>) => void): Unsubscribe;
     close(): Promise<void>;
     readonly protocol: ProtocolHandshake;   // negotiated at connect (Decision 5)
   }
   ```

   The host mirror is `WorkerHost.handle(port, msg)`, keeping the exact seam the
   39 existing tests drive. Leaving families to import the loose function kit was
   rejected: with no front door there is no place to hang the protocol version or
   the connection lifecycle, which is why both are scattered today.

5. **One handshake replaces the two rival "version" methods.** A response-free
   connect frame carries the protocol version alongside the app options, posted
   immediately after the port opens; MessagePort FIFO ordering guarantees the
   host reads it before any op — the same discipline `appConfig` already relies
   on. The rival `getRuntimeEpoch` and `getVersion` calls fold into one exchange
   surfaced on `transport.protocol`:

   ```ts
   interface ProtocolHandshake {
     readonly version: string;     // wire protocol version (this ADR's contract)
     readonly buildEpoch: string;  // absorbs getRuntimeEpoch (staleness)
     readonly instanceId: string;  // absorbs getVersion (which sandbox instance)
     readonly peer: 'page' | 'bridge' | 'remote';
   }
   ```

   Retirement keys off a `version` mismatch as well as a `buildEpoch` mismatch,
   so a wire-incompatible worker retires instead of mis-decoding. Frames at the
   two compat boundaries (Decision 1) are additive-only and decoded tolerantly.
   Semantic-versioning the internal contract was rejected in Decision 1; this
   version string governs only the retirement and relay boundaries.

6. **One codec and one error frame.** A `WireCodec` module owns the three
   encodings that genuinely differ — the structured-clone envelope, the
   marker-JSON round-trip that rehydrates Firestore wrapper instances, and
   base64 for byte payloads — behind one small interface both sides import. A
   single `snapError` / `serializeError` builder owns the `{ __error }` snap
   convention, which is currently hand-reconstructed in ~5 host sites and
   re-parsed in ~3 client sites. A public API has one serialization contract;
   this makes wire-format drift structurally impossible rather than a review
   burden. The three side-by-side strategies (marker-JSON, base64, and the
   inline `JSON.parse(JSON.stringify)` on tool results) become three adapters
   behind the codec, not three call-site decisions.

7. **Migration follows section 7 and extends ADR-0005's follow-up boundary.**
   Mechanical moves are their own commits, behavior change moves no files, and
   the `@pyric/cli/serve/worker` export path never changes. The sequence:

   - **A — thicken the net.** The frozen dispatch-table test and the single
     end-to-end round-trip (`integration.test.ts`, with a hand-built
     `portPair()`) are the characterization net. Today the round-trip covers
     only firestore, auth, and transactions; extend it to drive rtdb, storage,
     presence, messaging, ai, and the event stream through the real client
     barrel before any move. This shared harness is the conformance suite a
     public API ships, and every later phase must leave it green unchanged.
   - **B — registry behind the union.** Introduce `OperationSpec`, the per-file
     records, and computed dispatch while the wire and the union stay
     byte-identical. No client change; the frozen dispatch-table test flips from
     an asserted count to a snapshot derived from the registry.
   - **C — type the front door.** Land `WorkerTransport` / `WorkerHost` and
     migrate families from raw literals to `transport.call`. Response types
     replace the `as { … }` casts.
   - **D — one handshake.** Add the connect version frame; retire
     `getRuntimeEpoch` and `getVersion` behind `transport.protocol`.
   - **E — one codec.** Extract `WireCodec` and the single error frame.
   - **F — symmetric layout.** Move the sibling `host-auth.ts`, `host-ai.ts`,
     `host-messaging.ts`, and `host-events.ts` under `host/` so the host tree
     mirrors `client/` family-for-family (code-conventions section 8.5). Pure
     mechanical move; best folded into B, which touches these files anyway.

   Each phase runs the full worker, browser, bridge-relay, packaging, and
   install-matrix gates before merging.

8. **Host handle-resolution is a separate follow-up.** `HostCtx` carries ~14
   lens/session handle caches — one "resolve a data handle for (surface, lens)"
   algorithm smeared across the shared context, the transport twin of the
   god-object code-conventions section 2 flags. A `HandleResolver` deepening is
   worth doing but has no wire impact and is out of this ADR's scope; it is
   sequenced after the front door lands and reviewed on its own.

9. **The record architecture bounds file and function size; the house lint
   closes the rest.** Size discipline stops being a reviewer's judgment call and
   becomes a property of the shape. Each `OperationSpec` is one small file — a
   method, two codecs, and one handler — so the 456-line `host/firestore-writes.ts`
   and the 1,130-line `protocol.ts` dissolve into per-op records that sit well
   under the 600-line trigger. A handler is a free function that accepts its
   dependencies `(ctx, port, req)`, not a method on a shared object, so it stays
   short and is unit-testable on its own. Three rules the transport's lint
   enforces, mandated here so they are mechanical, not taste:

   - **Named conditions.** A boolean used in an `if`, `while`, or ternary that is
     not a single identifier or a single comparison is lifted to a
     `const intentName = …` first. The existing extraction of `isRemoteRelay`
     and `tracksFirestoreActivity` in `host/dispatch.ts` is the model; the logic
     that decides whether an op is lensed, or which handle a lens resolves to,
     reads as a sequence of named facts.
   - **No odd ternaries.** A ternary selects between two simple values. Anything
     whose branch is itself a ternary, or that has more than two outcomes,
     becomes a named function, a `switch`, or a lookup — never a nested `?:`.
   - **One concept, one handler per file.** Code-conventions section 2 applied to
     records: a file holds one operation's handler and its private helpers, and
     nothing else.

   Leaving size and clarity to review was rejected. `protocol.ts` reached 1,130
   lines and `HostCtx` reached ~30 fields precisely because appending to the big
   file was the path of least resistance; the record architecture removes that
   path, and lint closes the line-level gaps so they never depend on a reviewer
   noticing them.

10. **Parallel work lands in separate files by construction.** The explicit goal:
    N contributors implementing N surface gaps at once produce N diffs that do
    not touch a shared file — code-conventions section 6 realized for the
    transport. Today three shared write-targets generate the conflicts: the
    `OpMessage` union, the `isXxxOp` dispatch cascade, and the frozen
    `ROUTABLE_METHODS` test. All three dissolve. A new operation is a new record
    file, its mirrored client caller, and its own test — each owned by exactly
    one PR; two agents adding two operations never edit the same line.

    Two rules keep it that way:

    - **Aggregation is computed, never enumerated.** The registry is discovered
      from the records directory (the directory is the index), and the client
      barrel is derived the same way. No hand-maintained `export *` list or
      central `{ addDoc, setDoc, … }` map that every new family appends to — that
      map would just be the next shared write-target. This is the compat-registry
      and oracle-observation pattern, which already never conflict on additions.
    - **The shared contract is small and changed rarely.** The only files more
      than one operation touches are the deliberately-stable seam: the frame
      envelope types, the `WireCodec` interface, the `WorkerTransport` /
      `WorkerHost` interfaces, and the protocol version. Section 6's rule is to
      keep the seam stable, not the file small — so those are treated as the
      fragile contract, changed deliberately and reviewed as a wire change under
      Decision 1's boundary. Everything else is per-record and conflict-free.

    The symmetric split (code-conventions section 8.5, completed by phase F) puts
    a family's client and host halves in separate mirrored files, so work on two
    surfaces never collides. A central registry object literal that every op is
    added to was rejected for the reason above: it would reintroduce the single
    write-target the per-record structure exists to remove.

## Consequences

- Adding an operation becomes one new record file. `protocol.ts` stops being a
  1,130-line union and shrinks to shared frame types; the three-list lockstep
  and its frozen-count test collapse into a registry snapshot.
- Client callers get a typed `call`; the `res.value: unknown` casts disappear.
- The connection lifecycle — version, staleness, instance id, disconnect,
  retirement — converges on one handshake and one front door instead of two
  rival methods and scattered special cases.
- The transport gains one conformance harness that runs every operation across
  the real seam, closing the end-to-end gap for rtdb, storage, presence,
  messaging, ai, and events.
- A wire change is reviewed for its effect on retired workers and the
  `pyric-admin` relay, and only there; the internal client-to-host contract
  stays free to move in lockstep.
- No public package subpath changes. `@pyric/cli/serve/worker` is unchanged
  throughout.
- Files stay small by construction and handlers read as short sequences of named
  steps; the 1,130-line `protocol.ts`, the 456-line write family, and the
  ~30-field `HostCtx` are all gone rather than merely trimmed.
- Two contributors adding two operations touch no common file. The only shared
  edits left are deliberate changes to the small wire contract, which are already
  reviewed as wire changes at the named boundary — so the merge-conflict surface
  shrinks from "every op edits three shared files" to "only a wire-contract
  change is shared."
- CONTEXT.md gains the transport vocabulary (WorkerTransport, WorkerHost,
  OperationSpec, the operation registry, WireCodec, protocol version) when the
  work lands, so code, tests, and reviews use one name per concept.

## Enforcement

A structural test over `packages/cli/src/serve/worker` can decide the design
mechanically, as the conventions linter does for code-conventions section 8.7:

1. **Registry completeness.** Every method reachable on the wire has exactly one
   `OperationSpec`, and every spec's method is reachable. No method string is
   declared outside a record.
2. **No hand-maintained method list.** No source or test file enumerates the op
   methods; routing and the dispatch-table snapshot both derive from the
   registry.
3. **No `unknown` op result.** The response type of every `OperationSpec` is a
   concrete type, not `unknown`.
4. **Version present at connect.** A port that sends an op before the connect
   handshake frame is rejected, and the two compat boundaries assert additive,
   tolerant decode.
5. **Size triggers.** No transport source file exceeds 600 lines and no handler
   exceeds its extraction ceiling (code-conventions section 2), checked as a
   test so a growing handler fails rather than waits for a reviewer.
6. **Line-level lint.** The named-condition and no-odd-ternary rules of Decision 9
   run as lint over `serve/worker`, alongside the existing house rules.
7. **One write-target per operation.** A structural check that a method string,
   its handler, its client caller, and its test each live in that operation's own
   files, and that no file enumerates more than one operation's routing — so
   adding an op edits no file another op owns.
8. **Computed aggregation.** No hand-maintained barrel or method list feeds the
   registry or the client surface; the index is the directory.

Checks 1–3, 5, and 7 fail on the current tree by design and pass as phases B and
C land, so they double as the migration's definition of done. Checks 6 and 8 are
the guardrails that keep code health and the conflict-free structure from eroding
once the shape is in place.

## Amendment (2026-07-23): a firestore-writes spike sharpened six points

A throwaway prototype — one green end-to-end test driving a typed
`WorkerTransport` against a computed-dispatch `WorkerHost` over the real fake-port
harness — validated the core shape on the firestore-writes surface and corrected
six under-specifications. The prototype is not production and is not part of the
migration; it exists only to de-risk this design before phase A, and it is
discarded once its lessons are recorded here.

Confirmed by the spike: the typed `call` removes the call-site cast (a handler
result is read as `res.path` with no `as`); computed dispatch needs no union or
switch edit (the host is a registry lookup); per-record op files are ~30–60 lines
each; and lens, codec, subscription, and the bridge relay all survive the typed
front door — an `{ mode: 'admin' }` lens write bypasses a rule that denies the
same write under the session lens, and a `serverTimestamp` round-trips back as a
real `Timestamp` instance. The central claim held: an operation is a
self-describing, typed record and dispatch is computed. The six corrections do
not break that; they sharpen it.

1. **The handler needs a surface-resolved handle, and that handle's type is
   surface-specific.** `msg.actAs` is an envelope field, stripped before the
   request codec runs, so a handler cannot reach it — yet a Firestore handler
   must run against the `lensDb`/`sessionDb`-resolved `Firestore`, an RTDB handler
   against a `Database`, a Storage handler against a `FirebaseStorage`. A single
   uniform `handle(ctx, port, req)` cannot be typed for it; the prototype adds a
   fourth `db: Firestore` argument as a stand-in (`prototype/operation.ts`).
   Correction: `OperationSpec` is parameterized by surface, and the dispatcher
   resolves the surface's handle from `actAs` before calling `handle`.
   Consequence: the `HandleResolver` of Decision 8 is **not** separable from the
   front door — the handle signature depends on it — so it moves into phase C
   rather than being deferred.

2. **The registry is two faces of one source, not one `ReadonlyMap`.** Decision
   2's `ReadonlyMap<string, OperationSpec>` erases per-key types, so the typed
   `call` of Decisions 3–4 cannot be derived from it. The design needs both a
   type-level `method → spec` record (for `Req`/`Res`) and a runtime `Map` (for
   dispatch), folded from one `as const` source. Decision 2's sample is amended to
   show both faces.

3. **Computed aggregation must be a generated typed manifest, not a
   hand-maintained tuple.** A directory glob (Decision 10, "the directory is the
   index") gives the runtime `Map` for free but cannot preserve the const-tuple
   literal types the type-level registry needs. A hand-maintained `OPS as const`
   tuple supplies the types but is itself the single shared write-target Decision
   10 exists to remove — every new op would edit it. The resolution is the
   repository's own generated-artifact rule: a typed manifest generated from the
   `ops/` directory, regenerated and never merged, so the directory stays the
   index, the types flow, and no contributor edits a shared list. Decision 10 is
   amended to require this; without it the registry tuple is the new conflict
   generator, and this ADR would contradict its own Decision 10.

4. **Subscriptions are a second record kind, parallel to operations.** A
   subscription fires one-to-many times and has no single response codec, so it
   does not fit `OperationSpec`; the prototype adds a distinct `SubscriptionSpec`
   (`register() → unsubscribe` plus a snapshot decoder) and a separate
   subscription registry. The "one operation is one record" framing must not imply
   subscriptions are operations — they are a second, parallel record kind, and the
   snapshot frame carries its kind structurally through the `target` shape the
   existing `SubMessage` union already uses.

5. **The codec splits by side; a single symmetric `WireCodec` module is wrong.**
   For write data, `encode` is pure `JSON.stringify` (a leaf, safe in the client
   bundle) while `decode`'s real work — marker rehydration and sentinel resolution
   (`prepareWriteData`) — pulls the engine and belongs only host-side. A single
   module imported by both sides would drag the ~10 MB engine into every served
   page, which is exactly what `protocol.ts`'s leaf `value-codec` import exists to
   prevent. Decision 6 is corrected: the codec has an explicit encode-side (a leaf,
   in both bundles) and decode-side (host-only), not one shared `Codec<T>` module.
   A related asymmetry the "one codec" framing hides: a request codec spreads
   fields into the op frame while a response codec returns a single `value`, so
   `Codec<T>` is not applied uniformly across the two directions.

6. **A fourth encoding exists: canonicalization-for-equality.** `txnCommit` was
   correctly outside the spike; its read-set validation depends on the
   `canonicalDocJson` canonicalizer (`host/firestore-writes.ts`) that reshapes
   prototype-stripped rules-wrapper clones into a deterministic marker form for
   string comparison. That is neither a request nor a response codec — it is a
   comparison codec used mid-handler. Decision 6's "one codec, three adapters" has
   no slot for it; it is named here as a fourth, host-only encoding.

Net effect on the plan: phase C absorbs the surface handle-resolver (correction
1); phases B and E gain the registry-manifest generation (correction 3) and the
side-split codec (correction 5); and the design gains a second record kind for
subscriptions (correction 4). Phase A — the conformance harness — remains the
first production step and is unchanged.
