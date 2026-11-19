import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["ref","child","get"],
  behavior: "`get(ref)` returns a `DataSnapshot`-shaped object with `val()`, `exists()`, `key`, `child()`, `hasChildren()`, `size`, and `toJSON()`; the modular Web surface does not expose `numChildren()`.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ref-navigation-and-absent-get`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ref-navigation-and-absent-get"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 8,
});
