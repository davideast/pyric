# Adapting Kin to a Firebase project

Kin is a local Pyric example. This branch does not deploy services or configure a live project. The seed contains fictional identities; do not treat their UIDs as production accounts.

## Configuration

Copy `.firebaserc.example` to the ignored `.firebaserc`, replace `YOUR_PROJECT_ID`, and configure the Storage/RTDB target names for your own project. Replace `YOUR_HOSTING_SITE` in `firebase.kin.json`. The example uses named resources `kin-db`, `kin-bucket`, and `kin-rtdb`; adapt those names to the resources you provision.

Keep Firebase web configuration in the ignored `.env.production.local`. `data.ts` reads `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_DATABASE_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, and `VITE_FIREBASE_DATABASE_URL`. Service-account keys and model-provider credentials must never be supplied through `VITE_*` variables or included in a browser build.

`firebase.kin.json` selects the named Firestore database and Storage target. `firebase.json` supplies the rules files used by local Pyric. No RTDB SDK operations or RTDB rules are included in this app.

## Known gaps before deployment

- **Storage authorization:** `storage.rules` uses family membership and post visibility in Firestore's default database. It does not implement a matching authorization projection for a named database; changing the database name alone is not a supported solution. Resolve this before deploying rules against `kin-db`.
- **AI generation:** `generation-ai-transport.ts` depends on the local Pyric bridge. Static Hosting alone cannot provide it. A production AI Logic transport or authenticated generation backend remains necessary.
- **Identity and onboarding:** create actual Auth users and corresponding family membership documents, enable Email Link sign-in, and authorize the application's hostname. The example has no invitation or production onboarding flow.
- **Content:** install the intended UI kit and templates and explicitly choose what demo content to retain; local seed state is not deployed automatically.
- **Shared Auth:** inspect any existing blocking functions and account restrictions in your project. Separate Firestore databases and buckets do not create separate Auth instances.

After resolving these gaps, validate family isolation, role permissions, attachments, email-link completion, and generated-app policies against the selected real services. Deploying backend rules changes those services immediately even if Hosting is only a preview channel. Do not deploy the supplied configuration unchanged.
