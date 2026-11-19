import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Op-level enforcement: `uploadBytes` against a denied path throws `storage/unauthorized` on sandbox / `storage/unauthorized` on prod, `.code` exposed on both",
  evidence: "ST-B1 fixed: sandbox now throws a `StorageError` (see `src/storage/errors.ts`) whose `.code === 'storage/unauthorized'` — matching prod's `FirebaseError.code`. Probe: `unit:error-codes.test.ts` (\"unauthorized when rules deny the operation\"). Residual divergence (documented, not a `.code` gap): the sandbox `StorageError.name` is `'StorageError'` (plain `Error` subclass, same shape as Firestore's `SandboxError`) where prod reports `name: 'FirebaseError'` / `isFirebaseError: true`, and the message wording differs (sandbox embeds the matched-rule reason chain). Oracle-locked: `packages/conformance/observations/storage/storage-rules-denied-error-code.json` (against digame-mas, fb-js-sdk 12.19.0: `code: 'storage/unauthorized'`, message `\"Firebase Storage: User does not have permission to access '<path>'.\"`, `name: 'FirebaseError'`, `isFirebaseError: true`). Extended 2026-10-27: `storage-rules-denied-signed-out-error-code` (digame-mas, fb-js-sdk 12.19.0) records that with no signed-in user an upload under `allow read, write: if request.auth != null` and one outside any grant both throw `storage/unauthorized` with HTTP 403, never `storage/unauthenticated`; the sandbox gives the same code, pinned by `unit:storage/oracle-conformance.test.ts`.",
  risk: ["specific-value","error-code","specific-field","rules-denial"],
  riskScore: 8,
  riskReasons: ["asserts 3 specific value(s)","asserts Firebase error code(s): `storage/unauthorized`, `storage/unauthorized`","asserts a specific field/property value","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["storage-rules-denied-error-code", "storage-rules-denied-signed-out-error-code"],
  conformanceTests: ["packages/pyric/test/storage/error-codes.test.ts"],
});
