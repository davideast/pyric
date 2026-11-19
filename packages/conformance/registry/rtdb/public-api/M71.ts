import { row } from './section.ts';

export default row({
  order: 800,
  featureKeys: ["ref","child"],
  behavior: "`DataSnapshot` shape: `size` (getter), `priority` (`null` when absent), `exportVal()`, `key`, `ref`, `val()`, `exists()`, `child()`, `hasChild()`, `hasChildren()`, `forEach()`, `toJSON()`. It does NOT ship the legacy namespaced `numChildren()` method (DB-B10)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/snapshot-shape.test.ts` (\"exposes size/priority/exportVal; NOT numChildren()\"); matches oracle `packages/conformance/observations/rtdb-modular/rtdb-modular-get-snapshot-shape.json` (`hasSize: true, hasNumChildren: false`) + upstream `api/Reference_impl.ts:288-447`. **Flipped masking tests**: `modular/queries.test.ts` + `modular/sandbox-target.test.ts` asserted `snap.numChildren()` — updated to `snap.size`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-get-snapshot-shape"],
  conformanceTests: ["packages/pyric/test/database/modular/snapshot-shape.test.ts"],
  rowNumber: 71,
});
