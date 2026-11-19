import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Round-trip: `set(ref, payload)` then `get(ref)` returns the payload (lock the basic write→read invariant)",
  evidence: "oracle: `packages/conformance/observations/rtdb/rtdb-set-then-get-roundtrip.json` — the payload round-trips structurally on both sides (this row's claim holds). `oracle-conformance.test.ts` also asserts the key order: production returns object children in key order (the capture's `roundTripEqual: false`: a `JSON.stringify` round-trip against a non-sorted payload fails), and so does the sandbox since #1371 (RT-7).",
  oracleObservations: ["rtdb-set-then-get-roundtrip"],
  conformanceTests: ["packages/pyric/test/database/oracle-conformance.test.ts"],
  aliases: ["rtdb#109"],
});
