import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: [
    'Reference.transaction',
    'Database.getRules',
    'Database.getRulesJSON',
    'Database.setRules',
    'enableLogging',
  ],
  api: 'ref.transaction(...) / db.getRules() / db.getRulesJSON() / db.setRules(source) / enableLogging',
  behavior:
  'Executes atomic `Reference#transaction(updateFn, onComplete?, applyLocally?)` with synchronous argument and pass-0 return validation, defensive cloning, array coercion, inline `.priority` and `ServerValue.increment` resolution, and contention retries; round-trips `Database#getRules()`, `getRulesJSON()`, and `setRules(source)` across string, `Buffer`, and object sources (preserving raw comments in `getRules()`, rejecting invalid arguments with `database/invalid-argument`, and rejecting malformed or uncompilable rulesets with `database/internal-error` without mutating active rules); and routes diagnostic log messages through `enableLogging(logger?, persistent?)`.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['rtdb-modular-admin-transaction-rules-and-logging'],
  conformanceTests: [
    'packages/pyric-admin/test/surface/admin-surface.test.ts',
    'packages/pyric-admin/test/database/integer-keys-parity.test.ts',
    'packages/pyric-admin/test/database/capture-admin-transaction-rules-and-logging.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/rtdb-admin-transaction-rules-and-logging.test.ts',
  ],
  evidence:
  'Production capture `rtdb-modular-admin-transaction-rules-and-logging` (`firebase` `12.19.0` / `firebase-admin` `13.10.0`) records `Reference#transaction` commit, `undefined` abort, `onComplete` callbacks, defensive clone, inline `.priority` + `ServerValue.increment`, two-client contention (normalizing the cross-WebSocket active-listener local `SyncTree` cache read `1` vs post-commit shared-backend `11`), synchronous validation throws, `getRules` / `getRulesJSON` / `setRules` string/Buffer/object round-trips and error codes, and `enableLogging` callback toggling; replayed across in-process, remote SharedWorker, served SharedWorker, and Node host planes.',
  risk: ['atomicity', 'error-code', 'stateful'],
  riskScore: 4,
  riskReasons: [
    'asserts transaction atomicity and synchronous validation',
    'asserts rules round-trip comment preservation and FirebaseDatabaseError codes',
  ],
});
