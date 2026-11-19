import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Inactive canonical `firebase/database` imports remain the upstream package; the mirror does not create tagged production targets",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-runtime-class-identity` records upstream `Database` constructor, `instanceof`, and `prototypeKeys`; `unit:modular/database-instances-cdd.test.ts` replays those invariants on an inactive canonical `firebase/database` `Database` handle while proving `TARGET_SYMBOL` is absent and Pyric `getDatabase(app)` rejects, alongside inactive-fixture coverage in `packages/cli/test/register/register-child.test.ts`.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtime-class-identity"],
  conformanceTests: ["packages/pyric/test/database/modular/database-instances-cdd.test.ts","packages/cli/test/register/register-child.test.ts"],
  aliases: ["rtdb#96"],
});
