# Replay Kin's family rules with `pyric verify`

Run these commands from `examples/family-space` after the repository build. The JSON files are small synthetic sandbox sessions, not exports of a real family. They include setup writes marked as admin, ordinary requests with expected allow/deny decisions, successful writes, and the final document state.

## Local replay

```sh
bun run verify
# Equivalent:
bunx --no-install pyric verify verify --engine sandbox
```

The three fixtures contain six successful non-admin writes and sixteen user requests overall. Local replay checks those successful writes against the current `firestore.rules` and compares the resulting state. Admin setup is replayed with rules bypassed, just as fixture setup should be.

**The local engine does not re-evaluate denied requests or reads.** Do not interpret its green result as proving that signed-out or outsider access is denied. It also does not cover Storage, Auth link delivery, generated-app client policies, or UI behavior.

To see a useful failure without changing the app's rules, create a temporary file outside the sample containing:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}
```

Run `pyric verify verify --engine sandbox --rules firestore=/absolute/path/to/deny-all.rules`. The previously permitted writes should fail verification and the command should return a nonzero exit code. It deploys nothing.

## Inspect the allow/deny cases

```sh
bunx --no-install pyric verify cases verify/family-isolation.json --service firestore --json
```

This derives the six family-isolation requests as Rules Test API cases. Repeat with `verify/parent-approval.json` and `verify/owned-data.json` to inspect all sixteen requests. Seven expect ALLOW and nine expect DENY. The fixtures pin the `get()` and `exists()` membership lookups using synthetic documents, so they do not depend on a live database. A denied update retains its attempted request data, not an after-state representing an unchanged document.

The embedded rules are the baseline when these fixtures were prepared; verification uses the current rules selected by `firebase.json`. Keep the baseline when changing candidate rules so that changes in behavior remain visible. Verbose rule traces and development provenance were omitted from these teaching fixtures.

## Optional hosted decision check

With your own authorized Google credentials configured through Application Default Credentials or an ignored `GOOGLE_APPLICATION_CREDENTIALS` file:

```sh
bunx --no-install pyric verify verify --engine both --project YOUR_PROJECT_ID
```

This adds Google's Rules Test API evaluation of the read, allowed-write, and denied-write cases, alongside the local replay. It sends the synthetic fixtures and candidate rules to Google; it does not deploy rules or write live Firestore data. This hosted command requires project permissions and is optional. A local pass does not imply that a hosted check has run.

To verify your own sandbox activity, `pyric verify` with no fixture argument uses the project's saved capture when one is available. Inspect that capture for personal data before sharing or committing it; the sample keeps runtime captures ignored.
