import { row } from './section.ts';

export default row({
  order: 100,
  behavior: "Prod: items + prefixes shape matches sandbox after `N` uploads under a directory",
  evidence: "oracle: `packages/conformance/observations/storage/storage-listall-shape.json` (against digame-mas, fb-js-sdk 12.19.0: 3 direct children + 1 grandchild → `items` has all 3 direct children sorted, `prefixes` has the single sub-folder, `itemCount: 3`, `prefixCount: 1`, `threeDirectChildren: true`, `oneSubPrefix: true`)",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["storage-listall-shape"],
});
