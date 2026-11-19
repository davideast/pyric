import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilityTableBlock } from './types.ts';

const SECTION = 'firebase-admin `getDatabase()` (`pyric-admin/database`)';

const adminCaptureTests = [
  'packages/pyric-admin/test/database/capture-admin-database-and-priorities.test.ts',
  'packages/cli/test/serve/worker/oracle-captures/rtdb-admin-database-and-priorities.test.ts',
];

const adminRow = defineRows({
  surface: 'rtdb-admin',
  defaults: {
    section: SECTION,
  },
});

const rtdbAdminRows: CompatibilityRow[] = [
  adminRow({
    rowRef: '1',
    featureKeys: ['getDatabase', 'getDatabaseWithUrl'],
    api: 'getDatabase(app?, url?) / getDatabaseWithUrl(url, app?)',
    behavior:
      'Resolves the default or explicit `PyricAdminApp`, caches handles per `(app, instanceUrl)` while rejecting mismatched URL string formats on an already-open instance, isolates named RTDB instances by URL, bypasses RTDB Security Rules as admin, throws `app/no-app` when no default app exists, throws `database/invalid-argument` (`FirebaseDatabaseError`) on an empty URL, and rejects calls after `deleteApp(app)`. When `databaseURL` is omitted from `app.options`, falls back to the project default RTDB instance rather than throwing `database/invalid-argument`.',
    status: 'diverged-documented',
    statusNote:
      'omitting app.options.databaseURL resolves the default project instance so zero-config local apps run, whereas production throws database/invalid-argument',
    automation: 'oracle-backed',
    oracleObservations: [
      'admin-app-no-app-error',
      'admin-app-getdatabase-missing-url',
      'rtdb-modular-admin-firebasedatabaseerror-and-url-binding',
    ],
    conformanceTests: [
      'packages/pyric-admin/test/app/oracle-conformance.test.ts',
      'packages/pyric-admin/test/app/registry.test.ts',
      'packages/pyric-admin/test/database/get-database-with-url.test.ts',
      'packages/pyric-admin/test/database/legacy-default-url.test.ts',
      'packages/pyric-admin/test/database/app-and-url-parity.test.ts',
      ...adminCaptureTests,
    ],
    evidence:
      'Production captures `admin-app-no-app-error`, `admin-app-getdatabase-missing-url` (firebase-admin 13.10.0), and `rtdb-modular-admin-firebasedatabaseerror-and-url-binding` alongside lifecycle and multi-instance routing tests in `registry.test.ts`, `get-database-with-url.test.ts`, `legacy-default-url.test.ts`, `app-and-url-parity.test.ts`, and 3-plane capture replays.',
    risk: ['error-code', 'stateful'],
    riskScore: 3,
    riskReasons: ['asserts instance isolation, app/no-app, and zero-config URL fallback'],
  }),
  adminRow({
    rowRef: '2',
    featureKeys: ['Database.ref', 'Database.refFromURL', 'Reference.child'],
    api: 'db.ref(path?) / db.refFromURL(url) and Reference navigation (key, parent, root, child, toString, toJSON, isEqual)',
    behavior:
      'Normalizes slash-delimited paths while rejecting `db.ref("")` synchronously, validates full URLs against the database origin host in `refFromURL`, and exposes `key`, `parent`, `root`, `child(path)`, `toString()`, `toJSON()`, and `isEqual()` (including synchronous throw on `isEqual(null)`) identically across local and remote arms.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['rtdb-modular-admin-ref-navigation-and-url-errors'],
    conformanceTests: [
      'packages/pyric-admin/test/database/app-and-url-parity.test.ts',
      'packages/pyric-admin/test/database/firebase-admin-differential.test.ts',
      ...adminCaptureTests,
    ],
    evidence:
      'Production capture `rtdb-modular-admin-ref-navigation-and-url-errors` records root/nested Reference navigation, `refFromURL` routing and host/fragment/malformed URL throws, `db.ref("")`, and `isEqual(null)`; replayed verbatim across in-process, SharedWorker, and Node host arms alongside `firebase-admin-differential.test.ts` and `app-and-url-parity.test.ts`.',
    risk: ['specific-value'],
    riskScore: 2,
    riskReasons: ['asserts Reference URL formatting, host validation, and equality'],
  }),
  adminRow({
    rowRef: '3',
    featureKeys: [
      'Reference.set',
      'Reference.update',
      'Reference.remove',
      'Reference.push',
      'ServerValue',
    ],
    api: 'ref.set / update / remove / push and ServerValue.TIMESTAMP / ServerValue.increment(delta)',
    behavior:
      'Executes admin writes, multi-path atomic updates (including array `update()` index coercion), removals, chronologically ordered `push()` keys, `onComplete` callbacks, `ServerValue` sentinels, and synchronous payload/key validation matching `firebase-admin` 13.10.0 error text across local and remote arms.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['rtdb-modular-admin-writes-sentinels-and-validation'],
    conformanceTests: [
      'packages/pyric-admin/test/database/write-validation.test.ts',
      'packages/pyric-admin/test/database/sentinels-and-callbacks.test.ts',
      'packages/pyric-admin/test/database/shared-backend-parity.test.ts',
      ...adminCaptureTests,
    ],
    evidence:
      'Production capture `rtdb-modular-admin-writes-sentinels-and-validation` records `set`, multi-path and array `update`, `remove`, ordered 20-char `push` keys, `onComplete` callbacks, `ServerValue.TIMESTAMP` / `increment`, and synchronous validation throws; replayed verbatim across in-process, SharedWorker, and Node host arms.',
    risk: ['error-code', 'stateful'],
    riskScore: 3,
    riskReasons: ['asserts synchronous write validation and ServerValue sentinel resolution'],
  }),
  adminRow({
    rowRef: '4',
    featureKeys: ['DataSnapshot.val', 'DataSnapshot.forEach', 'DataSnapshot.exportVal'],
    api: 'DataSnapshot (val, exists, child, hasChild, hasChildren, numChildren, forEach, exportVal, toJSON, getPriority)',
    behavior:
      'Coerces dense/sparse integer-keyed objects to arrays in `val()` while preserving string keys in `exportVal()` and `toJSON()`, iterates children in key order with early-exit `forEach`, and clones values defensively across local and remote arms.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['rtdb-modular-sparse-integer-array-coercion'],
    conformanceTests: [
      'packages/pyric-admin/test/database/array-children.test.ts',
      'packages/pyric-admin/test/database/integer-keys-parity.test.ts',
      'packages/pyric-admin/test/database/snapshot-immutability.test.ts',
      'packages/pyric-admin/test/database/capture-sparse-integer-array-coercion.test.ts',
      'packages/pyric/test/database/cdd/capture-normalization-and-validation.test.ts',
      'packages/cli/test/serve/worker/oracle-captures/rtdb-normalization-and-validation.test.ts',
    ],
    evidence:
      'Production capture `rtdb-modular-sparse-integer-array-coercion` records `firebase-admin` and modular client `DataSnapshot` sparse array holes, `exportVal()`, `toJSON()`, `getPriority()`, `numChildren()`, and early-exit `forEach()`; replayed verbatim across in-process, SharedWorker, and Node host arms in `capture-sparse-integer-array-coercion.test.ts`, `array-children.test.ts`, `integer-keys-parity.test.ts`, and `snapshot-immutability.test.ts`.',
    risk: ['specific-value'],
    riskScore: 3,
    riskReasons: ['asserts integer-key array coercion, exportVal keys, and child iteration'],
  }),
  adminRow({
    rowRef: '5',
    featureKeys: ['Query.get', 'Query.once', 'Query.on', 'Query.off', 'Query.orderByChild'],
    api: 'Query ordering/bounds/limits (orderByChild, orderByKey, orderByValue, orderByPriority, startAt, startAfter, endAt, endBefore, equalTo, limitToFirst, limitToLast) and get / once / on / off',
    behavior:
      'Executes ordered, bounded, and limited reads (`orderByChild`, `orderByKey`, `orderByValue`, `orderByPriority`, `startAt`, `startAfter`, `endAt`, `endBefore`, `equalTo`, `limitToFirst`, `limitToLast`), binds 3-arg and 4-arg `this` context on `once` and `on`, scopes `off()` by query view, event type, callback, and context, and delivers `value` and two-phase windowed `child_*` events across local and remote arms. Under loaded rules, `Query#get()` rejects with `Index not defined` when `.indexOn` is absent for `orderByChild` or `orderByValue` while `once("value")` resolves (`orderByKey` and `orderByPriority` need no index); with no rules loaded, the zero-config sandbox requires no index.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: [
      'rtdb-modular-admin-query-index',
      'rtdb-modular-admin-query-bounds-listeners-and-context',
    ],
    conformanceTests: [
      'packages/pyric-admin/test/database/queries-parity.test.ts',
      'packages/pyric-admin/test/database/value-listeners-parity.test.ts',
      'packages/pyric-admin/test/database/child-listeners-parity.test.ts',
      'packages/pyric-admin/test/database/once-lifecycle-parity.test.ts',
      'packages/pyric-admin/test/database/remote-on-off-context.test.ts',
      'packages/pyric-admin/test/database/capture-admin-query-bounds-listeners-and-context.test.ts',
      'packages/cli/test/serve/worker/oracle-captures/rtdb-admin-query-bounds-listeners-and-context.test.ts',
    ],
    evidence:
      'Production captures `rtdb-modular-admin-query-index` and `rtdb-modular-admin-query-bounds-listeners-and-context` record `.indexOn` enforcement on `Query#get()`, all four orderings with cursor bounds and limits, 3-arg/4-arg `this`-context binding, context-scoped `off()`, and two-phase limited-window `child_*` eviction events; replayed verbatim across in-process, remote, SharedWorker, and Node host arms.',
    risk: ['listener', 'specific-value'],
    riskScore: 3,
    riskReasons: ['asserts query windowing, child event sequencing, and admin .indexOn enforcement'],
  }),
  adminRow({
    rowRef: '6',
    featureKeys: [
      'Database.goOffline',
      'Database.goOnline',
      'Reference.onDisconnect',
      'OnDisconnect.set',
      'OnDisconnect.update',
      'OnDisconnect.remove',
      'OnDisconnect.cancel',
    ],
    api: 'db.goOffline() / db.goOnline() and ref.onDisconnect() (set, setWithPriority, update, remove, cancel)',
    behavior:
      'Registers, cancels, and atomically executes queued `OnDisconnect` mutations (`set`, `setWithPriority`, `update`, `remove`, `cancel`) when `goOffline()` disconnects the admin database handle across local and remote arms, with one-shot drain semantics after `goOnline()`.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['rtdb-modular-admin-connection-and-ondisconnect'],
    conformanceTests: [
      'packages/pyric-admin/test/database/on-disconnect-parity.test.ts',
      'packages/pyric-admin/test/database/connection-and-wire-parity.test.ts',
      ...adminCaptureTests,
    ],
    evidence:
      'Production capture `rtdb-modular-admin-connection-and-ondisconnect` records queued `onDisconnect` `set`, `setWithPriority`, multi-path `update`, `remove`, `cancel`, and one-shot drain across `goOffline()` / `goOnline()`; replayed verbatim across in-process, SharedWorker, and Node host arms.',
    risk: ['stateful'],
    riskScore: 3,
    riskReasons: ['asserts disconnect queue execution and cancellation across goOffline/goOnline'],
  }),
  adminRow({
    rowRef: '7',
    featureKeys: ['Reference.setPriority', 'Reference.setWithPriority'],
    api: 'ref.setPriority(priority, onComplete) / ref.setWithPriority(newVal, newPriority, onComplete?) and inline .priority',
    behavior:
      'Executes `Reference#setPriority` and `Reference#setWithPriority` with `onComplete` callbacks, preserves inline `.priority` and `.value` metadata in `set()` and `update()` for `DataSnapshot#getPriority()`, `exportVal()`, and `orderByPriority()`, rejects non-null `setPriority` on absent nodes with `INVALID_PARAMETERS: could not set priority on non-existent node`, and validates priorities synchronously across local and remote arms.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['rtdb-modular-admin-priorities-and-inline-priority'],
    conformanceTests: [
      'packages/pyric-admin/test/database/write-validation.test.ts',
      ...adminCaptureTests,
    ],
    evidence:
      'Production capture `rtdb-modular-admin-priorities-and-inline-priority` records `setWithPriority`, `setPriority`, absent-node `INVALID_PARAMETERS` rejection, inline `.priority` / `.value` in `set()` and `update()`, `orderByPriority()` ordering, and synchronous priority validation throws; replayed verbatim across in-process, SharedWorker, and Node host arms.',
    risk: ['error-code', 'stateful'],
    riskScore: 3,
    riskReasons: ['asserts priority persistence, absent-node INVALID_PARAMETERS, and priority validation'],
  }),
  adminRow({
    rowRef: '8',
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
  }),
  adminRow({
    rowRef: '9',
    featureKeys: ['Database.useEmulator'],
    api: 'db.useEmulator(host, port)',
    behavior:
      'Rebinds reference and `refFromURL` URLs to `http://${host}:${port}/...` when called before the `Database` instance starts (allowing pre-start `(host, port)` overwrite and custom-host `refFromURL` resolution while routing sandbox and remote data operations locally), treats repeat `useEmulator` calls with the identical `(host, port)` and options after start as an idempotent no-op, and throws `FIREBASE FATAL ERROR` on post-start initialization or alteration, Admin `mockUserToken` options, or deleted databases.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['rtdb-modular-admin-use-emulator-validation'],
    conformanceTests: [
      'packages/pyric-admin/test/surface/admin-surface.test.ts',
      'packages/pyric-admin/test/database/capture-admin-use-emulator.test.ts',
      'packages/cli/test/serve/worker/oracle-captures/rtdb-admin-use-emulator.test.ts',
    ],
    evidence:
      'Production capture `rtdb-modular-admin-use-emulator-validation` records pre-start `http://${host}:${port}` URL rebinding and overwrite, `refFromURL` custom-host acceptance, host/port boundary interpolation, idempotent post-start repeat calls, and fatal errors on post-start alteration, `mockUserToken`, and deleted databases; replayed verbatim across in-process, remote SharedWorker, served SharedWorker, and Node host planes.',
    risk: ['error-code', 'stateful'],
    riskScore: 3,
    riskReasons: ['asserts pre-start URL rebinding, post-start fatal guards, and 4-plane admin data routing'],
  }),
  adminRow({
    rowRef: '10',
    featureKeys: ['FirebaseDatabaseError'],
    api: 'FirebaseDatabaseError runtime export',
    behavior:
      'Exports `FirebaseDatabaseError` as a runtime `Error` subclass from `pyric-admin/database` that prefixes error codes with `database/`, accepts an optional message override, and implements `toJSON()` returning `{ code, message }`.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['rtdb-modular-admin-firebasedatabaseerror-and-url-binding'],
    conformanceTests: [
      'packages/pyric-admin/test/surface/admin-surface.test.ts',
      ...adminCaptureTests,
    ],
    evidence:
      'Production capture `rtdb-modular-admin-firebasedatabaseerror-and-url-binding` records `FirebaseDatabaseError` `instanceof Error`, `database/` code prefixing, message override, and `toJSON()`; verified in `admin-surface.test.ts` and replayed across all planes.',
    risk: ['specific-field'],
    riskScore: 2,
    riskReasons: ['asserts FirebaseDatabaseError code prefixing, message override, and toJSON'],
  }),
];

export const rtdbAdminBlock: CompatibilityTableBlock = {
  kind: 'table',
  prefix:
    '## `pyric-admin/database`: Admin Realtime Database references, queries, listeners, and OnDisconnect\n\nThe admin Realtime Database plane (surface `rtdb-admin`), mirroring `firebase-admin/database` across in-process and remote worker sandboxes.\n',
  rows: rtdbAdminRows,
};
