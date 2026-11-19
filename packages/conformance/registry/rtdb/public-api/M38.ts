import { row } from './section.ts';

export default row({
  order: 550,
  featureKeys: ["getDatabase"],
  behavior: "Identity-aware live op routing -- sign-in/sign-out via Auth is observed by the next RTDB op and active listeners without re-binding",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-auth-change-live-routing` (`firebase` `12.19.0`) captures uninterrupted `signedOut -> alice -> bob -> signedOut -> alice` transitions on one `Database` handle across `get`, `set`, `onValue`, and `onChildAdded` (silent readable listener re-auth, `PERMISSION_DENIED` listener cancellation without resurrection, and upstream cold `g`-wire `PersistentConnection.get` `code: null` vs Pyric `rtdb-modular#110` `code: 'PERMISSION_DENIED'`). Replayed across in-process sandbox (`live-auth-listeners.test.ts`, `unit:modular/sandbox-target.test.ts`), served SharedWorker, and served Node host (`packages/cli/test/serve/worker/oracle-captures/rtdb-auth-change-live-routing.test.ts`, `packages/cli/test/serve/worker/rtdb-auth-change-listeners.test.ts`).",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-auth-change-live-routing"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts","packages/pyric/test/database/live-auth-listeners.test.ts","packages/cli/test/serve/worker/rtdb-auth-change-listeners.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-auth-change-live-routing.test.ts"],
  rowNumber: 38,
});
