# Arcade Firestore SDK capture

The release controller calls `captureAttempt(probeUrl, caseId, context)` from [capture.mjs](capture.mjs) once for each recipe case. It sends the real Firebase JavaScript SDK operation on Arcade's named trial database and fetches a full server snapshot with a second authenticated client. Keep the raw journal private and preserve the capture run's provenance alongside it.

Use the existing [Arcade release controls](../../../arcade/live/control.mjs) to verify the database UID, acquire exclusive ownership, activate the pinned stock bundle, corroborate write propagation with separate SDK controls, and restore and verify the prior release. Hold the same lease until restoration completes. Get the stock digest from the ruleset file bytes returned by Firebase Rules and keep the propagation journal. A successful read or elapsed time alone cannot establish write propagation. Include the active release identity, source digest, database UID and both pre- and post-attempt checks in the raw record.

Run the SDK hook inside that controller with the [locked SDK install](../../../arcade/live/package-lock.json). The controller supplies two separately initialized Firebase Auth handles with fresh anonymous users. Reuse one pair for the Yacht cases or create fresh pairs. For Sokoban use a different writer per case since the owner UID is the document ID. Hold each synthetic identity exclusively through the attempt.

```js
import { SDK_VERSION } from 'firebase/app';
import { getIdTokenResult } from 'firebase/auth';
import * as sdk from 'firebase/firestore';

// The controller imports captureAttempt, api, dbName and dbUrl by absolute path.
// It supplies probeUrl (a directory file URL ending in /), caseId, runId,
// writerAuth, readerAuth, verifyStock and journal.
const readDocument = path => api(dbUrl + '/documents/' + path);
const row = await captureAttempt(probeUrl, caseId, {
  runId, writerAuth, readerAuth, sdk, sdkVersion: SDK_VERSION, getIdTokenResult,
  readDocument,
  async createDocument(path, fields) {
    await api(dbUrl + '/documents:commit', 'POST', {
      writes: [{
        update: { name: dbName + '/documents/' + path, fields },
        currentDocument: { exists: false },
      }],
    });
    return readDocument(path);
  },
  verifyStock,
  journal,
});
```

`verifyStock({ phase, runId, databasePath, releaseName, stockSha256 })` independently checks the target and lock against trusted services before and after each attempt. Return `{ databaseUid, releaseName, rulesetName, rulesSha256, lockRunId, propagationReceiptSha256, verifiedAt }` plus the controller's verification details. Use an ISO UTC timestamp for `verifiedAt`. Archive the propagation receipt referenced by that digest. `journal(row)` persists each successive state of the raw record, including the input before sending any scored write, the SDK outcome, and the corroborated server readback. It should keep completed rows even if a later case fails.

Seed through the create-only privileged callback. All scored writes and complete baseline and post-write snapshots use Firebase client SDK handles and anonymous identities. Use the privileged read only to corroborate full fields and document `updateTime`. A denial must preserve every field and the server version. An allow must store the exact permitted update and advance the server version. For Sokoban the symbolic `$serverTimestamp` in the journal is an SDK transform, whose resulting typed timestamp comes from the server snapshot.

Write a raw private JSON file with `{ "rows": { "<caseId>": row } }` using every completed row returned by `captureAttempt`. The raw rows include the full typed SDK snapshots and matching REST documents for the seed, baseline and readback, the exact write, the SDK case outcome, and the deployment proofs. The Yacht row also includes the SDK transaction's baseline read. Run the reviewable verifier offline.

```sh
bun experiments/policy-oracle/adapters/arcade-sdk/v1/verify.mjs "$probe_dir" "$absolute_raw_receipt"
```

The verifier checks the raw rows against the pinned probe, then prints a JSON map from case ID to SDK verdict. Review the raw journal and associated controller records against the target, signing identities, release, write propagation receipt and restoration before admitting the result.
