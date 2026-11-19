import { row, adminCaptureTests } from './section.ts';

export default row({
  order: 100,
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
});
