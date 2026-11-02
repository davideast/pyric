# Empirical oracle harness

Locks ambiguous matrix rows by running probes against bare upstream
`firebase/auth` + `firebase/firestore` (no `@pyric/*` shim) against a
**real Firebase project**. Each observation captures what production
Firebase actually does so the matrix can cite "observed empirically
against firebase-js-sdk &lt;version&gt; on &lt;date&gt;" rather than guessing.

Methodology background: the design rationale.

## Why real cloud — not the emulator

The Firestore emulator has known divergences from cloud Firestore,
and the gap widens over time as cloud services evolve. For an oracle
that needs to be the source of truth, only the real service counts.
We use the upstream Web SDK against a dedicated Firebase project.

## One-time project setup

You need a dedicated Firebase project for oracle observations.
Putting these in a production project would pollute real data with
test users and test docs.

1. **Create the project.** In the Firebase console, create a new
   project named e.g. `pyric-oracle`. Stay on the free tier — the
   harness's traffic is negligible.

2. **Enable Anonymous sign-in.** Authentication → Sign-in method →
   Anonymous → Enable.

3. **Add a Web App** to the project. Project Settings → General →
   Your apps → `&lt;/&gt;` Web. Copy the config object — the JSON-shaped
   one with `apiKey`, `authDomain`, `projectId`, etc.

4. **Set Firestore rules scoped to the oracle namespace.** The
   harness writes every doc under the top-level `pyric_oracle`
   collection. Paste the following into Firestore → Rules:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{db}/documents {
      match /pyric_oracle/{run}/{doc=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```

   This restricts the oracle's access to its own namespace, so the
   harness can't accidentally touch anything else if you ever reuse
   the project.

## Credentials without a key file

The capture rigs authenticate through one module,
`packages/conformance/src/oracle-credential.ts`, which picks the credential
by one condition:

- `PYRIC_ORACLE_SA_PATH` is set: the rig reads that service-account key file
  and signs with its private key, as before.
- `PYRIC_ORACLE_SA_PATH` is unset: the rig uses Application Default
  Credentials (ADC) and reads the project from `PYRIC_ORACLE_PROJECT_ID`.
  ADC carries no project of its own, so the rig refuses to start without it.

The keyless setup impersonates the oracle project's Admin SDK service account,
`firebase-adminsdk-fbsvc@digame-mas.iam.gserviceaccount.com`. No key file is
created or stored anywhere.

### One-time IAM grant

A project owner runs these once. They change production IAM, so an agent
never runs them.

```sh
PROJECT_ID=digame-mas
ORACLE_SA=firebase-adminsdk-fbsvc@digame-mas.iam.gserviceaccount.com

# The API impersonation and signBlob go through.
gcloud services enable iamcredentials.googleapis.com --project="$PROJECT_ID"

# Let your Google account act as the oracle service account.
gcloud iam service-accounts add-iam-policy-binding "$ORACLE_SA" --project="$PROJECT_ID" \
  --member="user:<your Google account>" --role="roles/iam.serviceAccountTokenCreator"
```

Rigs that sign tokens also need the service account to sign as itself. An
impersonated credential has no private key, so firebase-admin
`createCustomToken`, App Check `createToken`, and the custom tokens
`run-rules-rtdb.ts` mints all sign through the IAM Credentials `signBlob`
endpoint, called with the service account's own token. That needs
`iam.serviceAccounts.signBlob` on the service account itself. Check first,
read-only:

```sh
gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:$ORACLE_SA" --format='table(bindings.role)'
gcloud iam service-accounts get-iam-policy "$ORACLE_SA" --project="$PROJECT_ID"
```

If neither lists `roles/iam.serviceAccountTokenCreator` for the service
account, grant it on itself:

```sh
gcloud iam service-accounts add-iam-policy-binding "$ORACLE_SA" --project="$PROJECT_ID" \
  --member="serviceAccount:$ORACLE_SA" --role="roles/iam.serviceAccountTokenCreator"
```

IAM bindings can take a few minutes to take effect.

### Log in

```sh
gcloud auth application-default login \
  --impersonate-service-account=firebase-adminsdk-fbsvc@digame-mas.iam.gserviceaccount.com
```

This writes an `impersonated_service_account` file to
`~/.config/gcloud/application_default_credentials.json`. Then, in the root
`.env`:

```sh
PYRIC_ORACLE_PROJECT_ID=digame-mas
```

Remove `PYRIC_ORACLE_SA_PATH` from `.env` and your shell: when it is set, the
key file wins. Leave `GOOGLE_APPLICATION_CREDENTIALS` unset too, because ADC
reads the file it names before the gcloud file; a rig warns when it is set.

Before its first request, a rig resolves the service account ADC acts as and
logs it, for example
`[oracle] credential: Application Default Credentials for firebase-adminsdk-fbsvc@digame-mas.iam.gserviceaccount.com, project digame-mas`.
It refuses to start when ADC names no service account (a plain
`gcloud auth application-default login` without impersonation), or when the
account's `@<project>.iam.gserviceaccount.com` project is not
`PYRIC_ORACLE_PROJECT_ID`. The secondary project is the exception to the
project match: the same oracle account reaches it across projects, so it only
has to be a service account.

A CI Workload Identity Federation file in `GOOGLE_APPLICATION_CREDENTIALS`
works only when it impersonates a service account (its
`service_account_impersonation_url` names one in the oracle project). A
federated identity without impersonation names no service account and is
refused. Rigs that use a second
project read `PYRIC_SECONDARY_ORACLE_SA_PATH`, or
`PYRIC_SECONDARY_ORACLE_PROJECT_ID` with the same ADC login, in the same way.

### How long it lasts

The ADC file holds your user refresh token, not a service-account token. Each
access token the rigs get from it is a one-hour token for the service account,
minted on demand, so a run never needs a fresh login partway through.

The login itself lasts until the refresh token stops working: you revoke it
(`gcloud auth application-default revoke`), the token goes unused for six
months, your organization's Google Cloud session length policy ends it, or
the Token Creator grant is removed. When that happens a rig fails at its first
token request; run the login command again.

### Rigs this does not cover

These rigs authenticate with their own credential, not the oracle credential,
and still need a key:

- `functions-rtdb` reads the deployer key from `PYRIC_FUNCTIONS_RTDB_SA_PATH`,
  passes it to `firebase deploy` as `GOOGLE_APPLICATION_CREDENTIALS`, and
  writes its `client_email` into the deployed function's runtime config.

No oracle rig needs a private key: every signature the oracle rigs make goes
through `signBlob` under ADC. The Rules Test API rigs (`rules-firestore`,
`rules-storage`, `storage-stdlib-discovery`, and the stdlib and acceptance
probes) already work keyless through
`packages/pyric/test/rules/parity/credential.ts`, which falls back to the same
gcloud ADC file.

### Messaging on the oracle project

The messaging rigs (`messaging-send`, `messaging-web`, and
`src/check-messaging-provisioning.ts`) send to FCM through
`src/messaging-credential.ts`, which picks the credential by one condition:

- `PYRIC_MESSAGING_SA_BASE64` is set: the rig decodes that service-account key
  and sends with it, and the key names the project. A set
  `PYRIC_MESSAGING_PROJECT_ID` must name the same project.
- `PYRIC_MESSAGING_SA_BASE64` is unset: the rig uses the same Application
  Default Credentials login as the oracle rigs, through
  `src/oracle-credential.ts`. The project is `PYRIC_MESSAGING_PROJECT_ID`, or
  `PYRIC_ORACLE_PROJECT_ID` when that is unset, so messaging runs on the oracle
  project, `digame-mas`, with no extra variable. The account check is the
  oracle one: the rig refuses an account that is not a service account of the
  messaging project.

Remove `PYRIC_MESSAGING_SA_BASE64` from `.env` and your shell to run keyless,
because the key wins when it is set.

An FCM HTTP v1 send needs an access token with the `firebase.messaging` or
`cloud-platform` scope. Under ADC, firebase-admin asks for both, and gcloud's
impersonated login passes them to the service account's token. A key mints a
token for `firebase.messaging` alone.

#### One-time setup on the messaging project

A project owner does these once on `digame-mas`. They change the production
project, so an agent never does them.

1. **Enable the FCM API.** The send plane is the Firebase Cloud Messaging API
   (`fcm.googleapis.com`):

   ```sh
   gcloud services enable fcm.googleapis.com --project=digame-mas
   ```

2. **Check the send permission.** The Admin SDK service account needs
   `cloudmessaging.messages.create`. Its default role, Firebase Admin SDK
   Administrator Service Agent, carries it. Check read-only:

   ```sh
   gcloud projects get-iam-policy digame-mas --flatten='bindings[].members' \
     --filter='bindings.members:serviceAccount:firebase-adminsdk-fbsvc@digame-mas.iam.gserviceaccount.com' \
     --format='table(bindings.role)'
   gcloud iam roles describe roles/firebase.sdkAdminServiceAgent | grep cloudmessaging.messages.create
   ```

   If no role it holds carries the permission, grant
   `roles/firebasecloudmessaging.admin` to the service account.

3. **Create the Web Push certificate.** For `messaging-web` only. In the
   Firebase console, open Project settings, then Cloud Messaging, then Web
   configuration. Under Web Push certificates, choose Generate key pair. The
   value shown is the VAPID public key.

4. **Pick the web app.** For `messaging-web` only. Use the web app of the
   oracle project (Project settings, General, Your apps). The oracle web
   config, `PYRIC_ORACLE_FIREBASE_CONFIG`, already works. If the app's browser
   API key has API restrictions, they must allow the Firebase Installations API
   and the FCM Registration API, which `getToken` calls.

Then, in the root `.env`, with the oracle login from [Log in](#log-in):

```sh
PYRIC_ORACLE_PROJECT_ID=digame-mas
# messaging-web only: the web app config as one line of JSON, and the key pair.
PYRIC_MESSAGING_FIREBASE_CONFIG='{"apiKey":"…","authDomain":"digame-mas.firebaseapp.com","projectId":"digame-mas","storageBucket":"…","messagingSenderId":"<project number>","appId":"1:<project number>:web:…"}'
PYRIC_MESSAGING_VAPID_KEY=<Web Push certificate key pair>
```

Before the browser opens, `messaging-web` refuses a web config whose
`projectId` is not the credential's project, a `messagingSenderId` that is not
the project number in the config's `appId`, and a VAPID key that is not a P-256
public key. A VAPID public key names no project, so FCM checks that one when
`getToken` registers the browser.

Check the send plane before a capture. It makes three dry-run sends and
delivers nothing:

```sh
bun --env-file=.env packages/conformance/src/check-messaging-provisioning.ts
```

## Running the harness

The harness always loads the oracle credential described above, and deploys
and restores the oracle rules:

```sh
PYRIC_ORACLE_PROJECT_ID=digame-mas bun run packages/conformance/src/run.ts
```

It reads the Web SDK config through the Firebase Management API, or from
`PYRIC_ORACLE_FIREBASE_CONFIG` when that is set. That config must be for the
same project as the credential:

```sh
export PYRIC_ORACLE_FIREBASE_CONFIG='{"apiKey":"…","authDomain":"…","projectId":"…","storageBucket":"…","appId":"…"}'
PYRIC_ORACLE_PROJECT_ID=digame-mas bun run packages/conformance/src/run.ts
```

To run the client probes with no credential, pass `--manual-config` with
`PYRIC_ORACLE_FIREBASE_CONFIG` set. That run deploys no rules, and every probe
that needs the credential is reported as skipped. A skipped probe never
overwrites its observation, and the run exits non-zero listing the skips.

Each probe writes its observation to
`observations/&lt;surface&gt;/&lt;name&gt;.json`. Commit those JSON files
alongside the matrix — they're the locked oracle. Re-running the
harness updates them in place; the diff tells you whether cloud
behavior has shifted since the last observation.

The whole suite finishes in well under a minute (probes are tiny —
a handful of `setDoc`/`getDoc`/`deleteDoc` calls each).

## What the harness cleans up

- **Docs.** Each probe writes under
  `pyric_oracle/&lt;timestamp&gt;-&lt;random&gt;/&lt;probe&gt;` and deletes everything
  in that run namespace on the way out. A failed probe still gets a
  best-effort purge.
- **Firestore and Storage rules.** A run with a service account merges
  the `pyric_oracle` block into the project's deployed Firestore and
  Storage rules, and records the ruleset each release pointed to first.
  When the run ends, whether it passed, failed or was interrupted, the
  harness points each release back at the recorded ruleset and reads
  the release back to confirm it. If it cannot confirm the restore, it
  exits non-zero with a message naming the release and the ruleset to
  restore by hand. The Realtime Database rules merge is not restored.
- **Anonymous users.** Every probe that signs in deletes the
  anonymous user before returning, with one exception: the
  `auth-signout-idempotent` probe deliberately ends signed out, so
  the anonymous user it minted can't be deleted from the client
  SDK afterwards. **This leaks one anonymous user per run of that
  probe.** Anonymous users are free up to 50k MAU; periodically
  purge them from the console (Authentication → Users → filter to
  anonymous → delete) or via the Admin SDK if scale becomes an
  issue. Not in this harness's scope.

## Adding a probe

In `run.ts`, append to the `probes` array:

```ts
{
  name: 'firestore-some-behavior',   // file name + log label
  matrixRow: 'firestore #N',         // display prose for logs/docs
  rowIds: ['firestore#N'],           // structured registry links (validated both ways)
  description: 'one-line plain English',
  async observe() {
    await signInAnonymously(auth);
    // ... do the work, return a plain JSON-serializable object ...
    await dropCurrentUser();
    return { threw: false, fooBar: 'baz' };
  },
},
```

Write to `${RUN_ID}-&lt;probe-tag&gt;` for any docs you create — the
harness purges that namespace between probes so a failure can't
poison the next one. Return value becomes the `behavior` field of
the observation; keep it small and explicit.

## Current coverage and gates

The committed oracle now contains 197 observations across AI, Auth,
Firestore, RTDB, RTDB modular, Storage, and Messaging. The compatibility ledger is
loaded from the typed single-source registry in
`packages/conformance/registry/*.ts`. The `COMPAT.md` files are ignored,
generated public docs, not inputs to the compatibility ledger or review diffs.

Useful commands:

```sh
bun run compat:generate         # regenerate public COMPAT.md docs from the registry
bun run compat:report           # coverage inventory; debt is reported, not failed
bun run compat:validate         # registry/observation linkage validation
bun run compat:audit            # high-risk ✓ rows lacking evidence
bun run compat:oracle-versions  # every observation matches bun.lock's firebase version
bun run compat:oracle-check     # run registry-linked conformance probes
```

`compat:oracle-check` is a derived gate: it does not carry a hand-written
status field. Each registry row can name observations and local probes.
If the probe passes, Pyric conforms to the pinned production behavior; if
it fails, the gate classifies the result as either infrastructure/setup or
a live behavior contradiction.

## Realtime Database probes

RTDB probes follow the same pattern but require **one additional
piece of project setup**: the oracle project must have an RTDB
instance with rules that permit anonymous writes under
`/pyric_oracle/*`.

- **Provision the instance.** Firebase Console → Realtime Database
  → Create Database. Pick any region; the harness discovers the
  instance URL via the Firebase Database Management API
  (`projects/<projectId>/locations/-/instances`).
- **Loosen the rules.** Paste this snippet into Realtime Database →
  Rules:

  ```json
  {
    "rules": {
      ".read": false,
      ".write": false,
      "pyric_oracle": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
  ```

- If the project has **no** RTDB instance, the harness silently
  skips RTDB probes (each one records `{ "skipped": true,
  "reason": "no rtdb instance on project" }` and the runner moves
  on). Firestore + Auth probes still run.
- If the project has an instance but the rules don't permit
  `/pyric_oracle/*`, the probes still record observations — they
  just capture the rules-rejection error shape instead of the
  happy-path behavior. The `rtdb-rules-denied-error-code` probe
  uses this on purpose to lock the upstream SDK's error shape.

RTDB observations now cover REST shape, rules deployment/denial, set/get,
server timestamps, listener basics, push keys, shallow reads, simulator
agreement, and the modular SDK surface. Run `bun run compat:report` for
the current row/observation counts instead of maintaining a prose list by
hand.
