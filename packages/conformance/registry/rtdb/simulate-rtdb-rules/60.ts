import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Returns `{ success: false, error: { code: 'INVALID_INPUT' } }` when input doesn't parse against `SimulationInputSchema` (e.g. path missing leading slash, operation not in read / write / validate)",
  status: "conforms",
  evidence: "`unit:simulation/handler.test.ts`",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/rules/rtdb/simulation/handler.test.ts"],
});
