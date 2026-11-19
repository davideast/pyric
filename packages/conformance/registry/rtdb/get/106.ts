import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Returns a `DataSnapshot` carrying `.val()`, `.exists()`, `.key`, `.ref`, `.size` (getter, returns child count), `.hasChildren()`, `.hasChild(path)`, `.forEach(cb)`. The legacy namespaced-SDK method `.numChildren()` is **NOT** on the modular DataSnapshot — use `.size` instead. Observed: `hasNumChildren: false`, `size: 3` for a `{a,b,c}` object, `forEachKeys: ['a','b','c']` against digame-mas, fb-js-sdk 12.19.0.",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-get-snapshot-shape.json`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["rtdb-modular-get-snapshot-shape"],
  conformanceTests: ["packages/pyric/test/database/modular/snapshot-shape.test.ts"],
  conformanceChecks: [{"finding":"DB-B10","observation":"rtdb-modular-get-snapshot-shape","expect":{},"probe":"packages/pyric/test/database/modular/snapshot-shape.test.ts","guards":"the modular DataSnapshot exposes size / priority / exportVal() (not the legacy numChildren())."}],
  aliases: ["rtdb#106"],
});
