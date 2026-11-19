import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "Observer object form `{next, error, complete}` works alongside the function form. **Partial observers are accepted — `{ error: fn }` with no `next` registers and routes denials to `error` (FS-B14, `isPartialObserver` semantics from upstream `api/observer.ts`); pre-fix it was misrouted as `SnapshotListenOptions` and threw \"missing next handler\".**",
  evidence: "oracle: `packages/conformance/observations/firestore/firestore-row-84-observer-object-form.json` — registered two listeners on the same doc: one as a bare function `(snap) => …`, one as `{next, error, complete}`. Both fired once on initial (`{v:0}`) and again after a write (`{v:1}`), capturing identical data. `error` never fired (no rule denial), `complete` never fired on `unsub()` (Firebase treats unsubscribe as a teardown, not a \"complete\" signal — the observer's `complete` callback is reserved for terminal stream end, which `onSnapshot` does not produce). The two registration shapes are interchangeable for fire dispatch. `unit:onsnapshot-observer-discriminator.test.ts` (error-only observer; verified failing pre-fix)",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-84-observer-object-form"],
  conformanceTests: ["packages/pyric/test/firestore/onsnapshot-observer-discriminator.test.ts"],
});
