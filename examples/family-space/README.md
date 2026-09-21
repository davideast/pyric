# Kin — a little closer

A React family workspace using ordinary Firebase SDK imports with Pyric's local sandbox. Parents curate the family feed and kid feeds; everyone can comment, share media, and chat. The Apps screen demonstrates AI-generated React apps with saved drafts, versions, and recoverable builds.

## Run locally

From the repository root:

```sh
bun install
bash scripts/build.sh
bun run --cwd examples/family-space dev
```

Open **http://127.0.0.1:5227/**. Expand **Try the example family**, choose an account, and send a sign-in link. Pyric displays the email locally; no external email is sent. Keep the requesting tab open while opening the link.

| Email | Role |
| --- | --- |
| `emma@kin.example` | Parent |
| `daniel@kin.example` | Parent |
| `sam@kin.example` | Kid |
| `zoe@kin.example` | Kid |

These identities and the seed records are fictional. `alex@kin.example` belongs to a different family for demonstrating denied access. The runtime chip and Studio expose the requests and rules decisions as you use the app.

## Verify the example with Pyric

```sh
bun run --cwd examples/family-space verify
```

This runs **`pyric verify verify --engine sandbox`** from the example directory. Pyric reads candidate rules from `firebase.json` and replays the three checked-in synthetic fixtures in `verify/`; no browser, credentials, live AI, or cloud deployment is needed.

| Fixture | Scenario |
| --- | --- |
| `family-isolation.json` | Family chat access, signed-out access, and an outsider from another family. |
| `parent-approval.json` | A kid submits a post, a parent publishes it, and a kid's edit must return it to review. |
| `owned-data.json` | Kids edit their own messages, cannot change a sibling's messages or promote themselves, and parents can moderate. |

**Local replay checks successful writes and resulting state. It does not re-evaluate reads or denied attempts.** The fixtures retain those expected decisions for the optional Rules Test API check described in [verify/README.md](verify/README.md). A green local replay is not a full authorization audit, a Storage check, or a UI test.

The sample has no custom test runner or browser test suite. Pyric's own SDK regression tests live in its packages.

```sh
bun run --cwd examples/family-space typecheck
bun run --cwd examples/family-space build
```

## Try the app

1. Sign in as Sam and submit a post for review. It appears in **My posts**.
2. Sign in as Emma, open **Parent review**, choose the family or specific kids, and publish the post.
3. Return as a kid, open the post, and comment. The parent can see that it was viewed. Editing the approved post as its author returns it to review.
4. Open **Schedule**, switch day/week/month, and open an event. In **Chat**, send a message and attach media. Voice recording needs microphone permission and localhost or HTTPS.
5. Open **Apps**, create a copy of Dinner Spinner or Chore Quest, interact with it, then reload to see saved data.
6. With an AI provider configured, create an app from a prompt, navigate away during the build, and return through the progress bar. Edit the app to create a new version; preview changes before activating them.

AI generation uses Pyric's provider settings in an ignored `.env.local`. It sends the selected family context to that provider and can incur inference charges. Templates work without making AI requests.

## Where the code lives

```text
src/
├── app.tsx                  # Sign-in, navigation, and page composition
├── data.ts                  # Firebase setup, records, and subscriptions
├── family/                  # Chat, schedule, post editor and detail
├── ui/                      # Shared presentation and styles
├── apps/
│   ├── *.tsx / *.ts         # App screens, drafts, versions, templates
│   ├── generation/          # Model transport, SharedWorker, checkpoints
│   ├── runtime/             # Compilation, iframe preview, host bridge
│   ├── policies/            # Generated-app write policies and validation
│   └── ui-kit/              # Discovery and retrieval of UI examples
└── diagnostics/             # Optional local build diagnostics
verify/                      # Pyric replay fixtures; no custom runner
templates/                   # Editable starter sources and catalog
public/                      # Media, fonts, and installation payloads
scripts/                     # Template/UI-kit authoring and dev support
docs/                        # Design sources, deployment limits, background
```

`firestore.rules`, `storage.rules`, and `firestore.indexes.json` define the backend boundaries. `seed.json` supplies local records. The seed does not install production accounts.

The generated app receives current member identity through `useAppIdentity()` and saves app-local records through `useAppData()`. Policy-enabled writes pass through the host's policy adapter. These local policies guide behavior inside Kin; the high-trust backend does not protect against a modified client bypassing them.

The generator's environment contract is in `src/apps/generation/generation-instructions.md`. Builds save checkpoints and immutable version artifacts in Firestore. Preview versions use temporary records; activating a version preserves the live app's records. Keep these boundaries when adapting the example.

## Templates and UI examples

Ten starters live in `templates/generated/`, with metadata in `templates/catalog.json`. After editing a template, run `node scripts/seed-templates.mjs` from this directory to update the seed and installation payload. Creating a template copy never modifies the original template.

The UI kit lives in Firestore under `families/parkers/uiKits/kin-v1/entries`. Generation retrieves selected examples rather than including the entire kit in the prompt. The bundled `public/ui-kit/kin-v1.json` installs missing entries into older local sandboxes. Existing entries are not overwritten.

## Local state and deployment limits

Tabs at the same origin share Pyric's local sandbox. Different browser profiles and devices have separate state; Tailscale access alone does not make that state a shared production database. Set `FAMILY_PORT` for another local port and `FAMILY_REMOTE_HOST` / `FAMILY_REMOTE_PORT` when using an HTTPS proxy.

This example is not ready to deploy unchanged. Static Hosting needs a production AI transport, named-database Storage authorization needs adaptation, and real Auth identities and membership onboarding must be provisioned. See [deployment limits](docs/DEPLOYMENT.md). Optional local diagnostic reporting is documented in [remote diagnostics](docs/REMOTE-DIAGNOSTICS.md). Media and font attribution is in [asset sources](docs/ASSETS.md).
