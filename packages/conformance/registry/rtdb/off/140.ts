import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "Public API",
  behavior: "`off(ref, 'value', cb)` removes only the specific callback",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-off-targeted-and-child-registrars` records `off(ref, 'value', cb1)` stopping `cb1` while `cb2` and child listeners at the same reference continue receiving subsequent writes; replayed alongside `oracle-conformance.test.ts` (`rtdb-onvalue-unsub-equivalence.json`).",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-off-targeted-and-child-registrars"],
  conformanceTests: ["packages/pyric/test/database/oracle-conformance.test.ts", ...listenersCaptureTests],
  aliases: ["rtdb#140"],
});
