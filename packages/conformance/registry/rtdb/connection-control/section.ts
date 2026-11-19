import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 210,
  prefix: "### `goOnline` / `goOffline` — connection control\n",
  defaults: {
    section: "Public API",
    api: "Public API",
    status: "conforms",
    evidence: "`oracle:rtdb-modular-gooffline-goonline-queue-and-isolation` + `unit:modular/oracle-conformance-offline.test.ts` + `unit:oracle-captures/rtdb-gooffline-goonline.test.ts`",
    automation: "oracle-backed",
    oracleObservations: ["rtdb-modular-gooffline-goonline-queue-and-isolation"],
    conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-offline.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-gooffline-goonline.test.ts","packages/pyric/test/database/cdd/public-operations.test.ts"],
  },
});

export const row = section.row;
