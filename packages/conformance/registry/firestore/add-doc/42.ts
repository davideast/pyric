import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Returned ref is usable in subsequent ops (`getDoc`, `setDoc`, `onSnapshot`)",
  status: "conforms",
  evidence: "`unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-row-42-adddoc-returned-ref-usable.json` — `addDoc(coll, {v:1})` returned a ref whose `.id` is a 20-char auto-id; `getDoc(ref)` returned `{v:1}` (round-trip), `setDoc(ref, {v:2})` overwrote without error, follow-up `getDoc` returned `{v:2}`, and `onSnapshot(ref, cb)` registered cleanly and fired once with `{exists:true, v:2}`. All four follow-up ops succeed on the returned ref without re-tagging.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-42-adddoc-returned-ref-usable"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
