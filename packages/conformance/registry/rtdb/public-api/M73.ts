import { row } from './section.ts';

export default row({
  order: 820,
  featureKeys: ["ref","child","root","set"],
  behavior: "A primitive at the ROOT is legal (`set(ref(db), 'hello')`); a subsequent child write replaces the primitive root (\"writes win\") (DB-B13)",
  status: "conforms",
  evidence: "Oracles `rtdb-modular-leaf-promotion-priority` and `rtdb-modular-set-replaces-not-merges` record scalar-leaf-to-parent child `set`/`update` promotion (\"writes win\" with retained `.priority`) and full replacement; replayed directly at `ref(db)` across sandbox (`unit:modular/root-primitive.test.ts`), served SharedWorker, and served Node host (`packages/cli/test/serve/worker/oracle-captures/rtdb-leaf-promotion-priority.test.ts`) because shared live `pyric_oracle` root `/` cannot be wiped without clobbering concurrent `/pyric_oracle/<runId>` runs.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-leaf-promotion-priority","rtdb-modular-set-replaces-not-merges"],
  conformanceTests: ["packages/pyric/test/database/modular/root-primitive.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-leaf-promotion-priority.test.ts"],
  rowNumber: 73,
});
