import { deniedListenerCancellations, listenerPermissionDenied, revokedListenerCancellations } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 850,
  featureKeys: ["onValue","onChildAdded","onChildChanged","onChildRemoved","onChildMoved"],
  behavior: "Value and child listener overloads accept a cancellation callback and deliver Firebase-shaped permission errors when a listen is denied or revoked; a callbackless listener that loses auth access is terminal and does not resurrect after sign-in.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-listener-cancellation` captures all five registrars returning normally, asynchronous initial-denial cancellation, one revocation callback each, and the Error/PERMISSION_DENIED/message shape; replayed in `unit:modular/listener-lifecycle-cdd.test.ts`.",
  risk: ["listener","rules-denial"],
  riskScore: 4,
  riskReasons: ["asserts listener semantics","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-listener-cancellation"],
  conformanceTests: [
    "packages/pyric/test/database/modular/listener-lifecycle-cdd.test.ts",
    "packages/pyric/test/database/denial-context.test.ts",
  ],
  conformanceChecks: [{
    finding: "RTDB-M75A",
    observation: "rtdb-modular-listener-cancellation",
    expect: { repeatCount: 2, allowedControl: { ok: true }, denied: deniedListenerCancellations, revoked: revokedListenerCancellations, controlAfterRevocation: { ok: true }, callbacklessAuth: { deliveries: [{ value: 0 }], signedOutCancellations: [listenerPermissionDenied], freshControlDeliveries: [{ value: 1 }] } },
    probe: "packages/pyric/test/database/modular/listener-lifecycle-cdd.test.ts",
    guards: "Denied and revoked value/child listeners deliver pinned cancellation shapes without mutating the control path.",
  }],
});
