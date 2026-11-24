# Google OAuth (`google.com`) Unverified-Account Capture Runbook (#1814)

This runbook explains how to execute the `auth-google-oauth` human-witnessed conformance rig (`packages/conformance/rigs/auth-google-oauth.ts`) to capture production Identity Platform / Firebase Authentication behavior when a real `google.com` OAuth sign-in collides with an existing unverified Email/Password account (`@gmail.com` vs. non-`@gmail.com`).

Because Google's login flow requires interactive browser authentication, `auth-google-oauth` is marked `automation: 'human-witnessed'` and `safety.unattendedSafe: false`. It is unreachable from unattended CI (`oracle-capture.yml`) and runs only from an operator machine with a desktop browser.

## 1. Firebase Console Prerequisites (One-Time Check)

Verify these four settings on the dedicated oracle Firebase project before running:

1. **Email/Password enabled:** In Firebase Console -> **Authentication** -> **Sign-in method**, confirm **Email/Password** is **Enabled**.
2. **Google provider enabled:** Under **Sign-in method**, confirm **Google** (`google.com`) is **Enabled** with a support email configured (this provisions the Web OAuth 2.0 Client ID used by `signInWithPopup`).
3. **Same-email account linking mode:** Under **Authentication** -> **Settings** -> **User actions** (or Identity Platform **Settings**), verify **"Link accounts that use the same email"** (one account per email address, `allowDuplicateEmails: false`) is selected. The rig also queries the project's Identity Platform admin config at runtime and records `projectAllowDuplicateEmails` in the observation.
4. **Authorized domain:** Under **Authentication** -> **Settings** -> **Authorized domains**, confirm `localhost` is listed.

## 2. Two Dedicated Throwaway Google Accounts Required

Never pass a personal or primary Google account. Prepare two dedicated throwaway Google accounts that do **not** have existing unmarked user records in the oracle Firebase project:

1. **Throwaway `@gmail.com` account (`--gmail`):** A disposable consumer Google account ending in `@gmail.com` (for example, `pyricoraclethrowaway@gmail.com`). Pass the exact canonical `@gmail.com` address Google returns on sign-in (without extra dot-alias or `+tag` variations), because the rig enforces exact case-insensitive string equality between `--gmail` and the signed-in Google account email.
2. **Throwaway non-`@gmail.com` Google account (`--non-gmail`):** Either:
   - a dedicated test account on a Google Workspace / Cloud Identity domain you control (for example, `pyric-oracle-test@example.org`), or
   - a consumer Google Account registered with a non-Gmail address via *"Use my current email address instead"* on a domain you control.

*(A GCP service account `*.iam.gserviceaccount.com` cannot substitute for either account because `accounts:signInWithIdp` requires an interactive Google user OAuth credential.)*

**Safety guards enforced by the rig:**
- Both `--gmail` and `--non-gmail` must be passed explicitly on the CLI; there are no defaults.
- Pre-flight calls `admin.auth().getUserByEmail(...)` on both addresses and **aborts immediately before modifying anything** if either email already exists in the project without the custom claim `{ pyricOracleGoogleOAuthTest: true }`.
- Startup sweep deletes **only** orphaned users carrying `{ pyricOracleGoogleOAuthTest: true }` from an earlier interrupted run.
- `finally` cleanup deletes **only** UIDs created in this run and verifies each deletion via `admin.auth().getUser(uid)` (`auth/user-not-found`); pressing `Ctrl+C` (`SIGINT` / `SIGTERM`) during a popup wait closes the local bridge and runs the same verified cleanup before exiting.

## 3. Exact Command to Run

1. Authenticate Application Default Credentials by impersonating the oracle project's Admin SDK service account (see `packages/conformance/docs/oracle-project-setup.md`):

```sh
gcloud auth application-default login \
  --impersonate-service-account=<oracle-admin-service-account-email>
```

2. Run the `auth-google-oauth` harness from the repository root with `--write` and both explicit throwaway email flags:

```sh
PYRIC_ORACLE_PROJECT_ID=<oracle-project-id> \
  bun run packages/conformance/src/capture/auth-google-oauth/harness.ts \
  --write \
  --gmail=<throwaway@gmail.com> \
  --non-gmail=<throwaway@example.org>
```

*(Optional flags: `--port=<n>` binds a specific loopback port instead of an ephemeral port; `--no-open` prints the `http://localhost:<port>` URL without invoking `open` / `xdg-open`.)*

## 4. What You Click and What You Should See

1. **Terminal startup & pre-flight:**
   - Prints `[oracle] credential: Application Default Credentials for ..., project ...`.
   - Verifies neither email exists unmarked in the project, sweeps any `{ pyricOracleGoogleOAuthTest: true }` orphans, seeds the unverified `@gmail.com` password account, and prints:
     - `[auth-google-oauth] interactive sign-in page listening at http://localhost:<port>`
     - `[auth-google-oauth] step 'gmail': sign in with <throwaway@gmail.com> at http://localhost:<port>`
2. **Click 1 (`@gmail.com` popup):**
   - Your browser opens `http://localhost:<port>` showing `Ready for Step 1 (@gmail.com)` and `Target account: <throwaway@gmail.com>`.
   - Click **`Step 1: Sign in with Google (gmail)`**.
   - In Google's account chooser popup (pre-hinted to `<throwaway@gmail.com>`), select `<throwaway@gmail.com>` and complete sign-in.
   - If a different Google account is accidentally selected, the rig detects the email mismatch before recording anything, deletes only the test user created in this run, and exits non-zero.
3. **Click 2 (non-`@gmail.com` popup):**
   - Once Step 1 is recorded and its temporary test user is cleaned up and verified deleted, the page updates to `Ready for Step 2 (non-@gmail.com)` and `Target account: <throwaway@example.org>`.
   - Click **`Step 2: Sign in with Google (non-gmail)`** and select `<throwaway@example.org>` in Google's popup.
4. **Completion & verified cleanup:**
   - The browser card displays: `Capture complete and test users cleaned up. You may close this browser tab.`
   - The terminal prints:
     `[auth-google-oauth] verified cleanup complete; wrote .../packages/conformance/observations/auth/auth-google-oauth-unverified-collision.json`
   - Inspect `git diff packages/conformance/observations/auth/auth-google-oauth-unverified-collision.json` to confirm it contains **only** booleans, provider IDs (`"password"`, `"google.com"`), and `auth/*` error codes -- zero emails, UIDs, display names, photo URLs, project IDs, or tokens.

## 5. Promoting the Captured Observation

Once `observations/auth/auth-google-oauth-unverified-collision.json` is captured on a branch:

1. In `packages/conformance/rigs/auth-google-oauth.ts`, promote `'auth-google-oauth-'` from `pendingPrefixes` into `observationPrefixes: ['auth-google-oauth-']` (and remove `pendingPrefixes`).
2. Link the `#1814` `auth` registry row(s) (`rowIds`), align any remaining runtime divergences with what production recorded, and run `bun run compat:check`.
