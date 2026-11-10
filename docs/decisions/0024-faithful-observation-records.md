# 0024: Pyric records what Firebase returns, and keeps credentials out at capture

Status: Accepted

Date: 2026-11-10

David decided the direction on 2026-11-10. This record states it, gives the
reasons, and lists the scrubbing on `main` that it retires.

## Context

Pyric records the developer's own Firebase calls. A record is what lands in
Traffic, Studio, the terminal, `.pyric/` state, `pyric verify` captures, repro
files, MCP results and the input to AI observations: document fields, Storage
metadata, error messages, paths, local rules verdict traces.

Several of those surfaces grew their own scrubbing, each written separately:

- Key-name lists that replace any field whose name matches
  `password|credential|secret|token|authorization|cookie|api[-_]?key` with
  `[redacted]`, and regexes that rewrite `Bearer ...`, `eyJ...` JWTs and
  `apiKey=...` inside strings.
- A predicate that drops an error message, or refuses a record, when a string
  "looks like" a token: a JWT, or a long opaque run of characters.
- Storage `customMetadata` values shown as `[REDACTED]` when the key or value
  looks secret, `firebaseStorageDownloadTokens` among them, and `token=`
  stripped from download URLs.
- `?key=`, `apiKey=` and `access_token=` masked to `***` in terminal lines.
- Repro files that rewrite every JWT into `{ "__redactedJwt": ... }` with its
  signature removed, and replace service-account fields with `[redacted]`.

Each one answered "do we scrub this?" The question this record asks instead is
"why would these files hold a secret in the first place?"

### Live mode sees only what the developer can already see

Live mode runs in the developer's own browser and Node processes, with their
own credentials, against their own Firebase project, usually a staging or
development one. Pyric holds no production credential (see
[Live mode](../../packages/site-docs/src/content/observe/live-mode.md)). Every
value a live row observes is a value the same user's own call just received.
The Firebase JS SDK already keeps that user's refresh token and ID token in
browser storage (IndexedDB under the default `browserLocalPersistence`;
[Auth state persistence](https://firebase.google.com/docs/auth/web/auth-state-persistence)).
A record of `items/{id}` holds nothing that user couldn't read from their own
DevTools. That argument holds only while Pyric's local surfaces answer the
developer alone, which decision 5 makes a precondition.

### Firebase doesn't put credentials in its answers

What Firebase returns from a call (a document, a listing, Storage metadata, an
error) doesn't carry the caller's credentials. The credentials are on the
request: the ID token in a header, the API key in the query string. So a
record holds a credential only when Pyric itself copies one in. The fix for
that is at the capture point that copies it, not a pass over every record
afterward.

Firebase web API keys aren't credentials either. "API keys for Firebase
services are not secret", and they are meant to ship in client code
([Learn about using and managing API keys for Firebase](https://firebase.google.com/docs/projects/api-keys)).

### Prior art: `.env` files

`.env` files hold real secrets, and nothing that reads them scrubs them.
[dotenv](https://github.com/motdotla/dotenv), Node's `--env-file` and Bun's
automatic `.env` loading all load the file as written. Keeping the file out of
a shared repository is the developer's job, done with `.gitignore`. Pyric's
local state follows the same model.

### What scrubbing cost

- **Fidelity.** A sandbox seeded from an observed session that holds
  `[REDACTED]` where the project held a value evaluates rules against the
  marker. A rule such as
  `allow read: if resource.metadata.shareKey == request.auth.token.shareKey`
  gets a different verdict locally than in production. A repro file whose JWTs
  became `{ "__redactedJwt": ... }` objects no longer replays: a JWT stored as a
  Storage `customMetadata` value fails the string-to-string check that
  `parseRepro` applies to checkpoints, and a rewritten value no longer matches
  the id it was bound to.
- **False positives.** A key-name list catches `pageToken`, `nextPageToken`
  and `tokenType`, which are ordinary fields. Each one needs an exception, and
  the exceptions pile up per module.
- **Complexity.** The same idea was implemented five separate times, each with
  its own patterns, markers and tests: observation previews (shared by
  traffic records, Storage rules enforcement and AI observation input), the
  observed-call reader, the Storage metadata policy (shared by live Storage
  capture and the Studio Storage browser), live terminal lines and repro
  export.

## Decision

### 1. A record holds what Firebase returned, as it returned it

Pyric records the result of the developer's own Firebase calls without
rewriting it. That covers:

- document fields and Realtime Database values;
- Storage metadata, including `downloadTokens`, download URLs with their
  `token=` parameter, and `customMetadata`;
- error codes and messages;
- paths, query field paths and listener ids;
- local rules verdict traces;
- terminal lines, repro files, MCP tool results and the input Pyric gives an
  AI observation.

There are no key-name lists, no token regexes and no `[REDACTED]` markers, at
capture or at egress.

### 2. Pyric never captures a credential value it doesn't use

The rule that keeps secrets out of records is about capture, not output. Pyric
reads a credential only for what it does with it, and drops the value:

- An ID token is decoded into `{ uid, claimNames, claims }`, which local rules
  evaluation reads as `request.auth`, and the token string is dropped
  (`packages/live/src/account.ts`, `accountOf`). `accessToken`,
  `refreshToken` and `stsTokenManager` are never recorded.
- The live `firebase/auth` and `firebase/app-check` rows record no arguments
  or results, so `getIdToken`, `getIdTokenResult`, `signInWith*` and App Check
  `getToken` never reach a record.
- The Admin project gate reads `projectId` / `project_id` from a credential,
  and never `private_key` or `client_email`. `verifyIdToken` records claim
  names and the resulting uid.
- The sandbox Auth backend's mutation events omit passwords and tokens.

When a capture point is found to record a credential that no reader uses, the
fix is to stop capturing it there.

### 3. Keeping local files local is the developer's job, as with `.env`

Pyric writes records to `.pyric/` and makes sure `.pyric/` is gitignored. It
doesn't rewrite what's in the files.

### 4. No redaction option now

An opt-in redaction flag could be added later if users ask for it. It isn't
added now, and nothing in this record depends on it.

### 5. Precondition: only the developer can reach Pyric's local surfaces

Unscrubbed records are safe because the only person who can read them is the
developer whose calls produced them. That holds only if every local surface
that serves records answers the developer alone. This covers the `/__pyric/*`
HTTP routes, the MCP endpoint, and the WebSocket and event streams the dev
server or live host mounts. Each one must:

- require the session's bridge token;
- reject a request whose `Origin` is not the dev server's own;
- reject a request whose `Host` is not a loopback name or address, so DNS
  rebinding can't reach it.

This record states the requirement. It doesn't claim that every surface
enforces it today. That is being checked separately, and any surface that
falls short is a defect against this record, fixed at that surface.

## Consequences

- **Records match production.** A seed from an observed session evaluates
  rules on the values production held, and a repro file replays byte for byte.
  [#2565](https://github.com/davideast/pyric/pull/2565) already reports live
  local rules verdict traces verbatim on this basis.
- **Local files can hold project data.** `.pyric/` state, `.pyric/last-session.json`,
  repro files and the MCP event log hold document values, Storage download
  tokens, `customMetadata` and error messages as the project returned them.
- **The local surfaces carry the boundary.** With no scrubbing behind them,
  decision 5 is the line between the developer and everyone else. A local
  route that answers without the token, or answers a foreign `Origin` or a
  non-loopback `Host`, now exposes verbatim project data. It is a
  security defect under this record, not a gap that scrubbing would have
  covered.
- **`.pyric/` is already gitignored, so no follow-up is needed for it.** Every
  scaffold's `.gitignore` lists `.pyric/`: all five `create-pyric` templates,
  which `pyric init` also uses (`web`, `node` and `static` through `GITIGNORE`
  in `packages/create-pyric/src/templates.ts`, `nextjs` through
  `NEXTJS_GITIGNORE` in `template-nextjs.ts`, and `chat` through
  `templates/chat/gitignore`).
  For an existing app, `ensureGitignored` (`packages/cli/src/serve/capture-store.ts`)
  appends `.pyric/` to its `.gitignore` the first time Pyric writes a capture,
  seeds hosted state from an observed session
  (`serve/hosted/seed-from-observed-session.ts`), or exports a live seed under
  `.pyric/` (`cli/seed-from-live.ts`, which warns when `--out` names a project
  file outside `.pyric/`).
- **Two record files live outside `.pyric/`.** `pyric serve repro capture`
  writes `pyric-repro.json` in the working directory by default, because it's
  a file meant to be attached to a bug report; where it goes is the
  developer's call. The MCP audit log is `~/.pyric/projects/<projectId>/events.ndjson`,
  in the home directory, outside any repository.
- **Scrubbing already on `main` is retired.** Each removal lands in a
  follow-up PR that cites this record:
  - `packages/pyric/src/sandbox/internal/observation-payload.ts`
    (`isSecretObservationKey`, `observationText`, `observationPayload`) and its
    callers: `sandbox/operation-record.ts` (traffic operation previews),
    `storage/enforce.ts` (captured text and Storage metadata in rules
    enforcement) and `packages/cli/src/serve/worker/ai-observation.ts` (model
    response text given to AI observations).
  - `packages/pyric/src/sandbox/internal/observed-call.ts`: `readOutcomeMessage`
    drops an error message that `isTokenShaped` matches. The same predicate
    also refuses records whose request fields, query field paths or listener
    ids look token-shaped; the follow-up decides which of those checks are
    input validation and which are scrubbing.
  - `redactUrl` (`packages/pyric/src/ai/broker/synthesizer.ts`) as applied to
    observed error messages in `packages/cli/src/serve/live-terminal-lines.ts`.
    The scenario assertion on masked URLs in `test/apps/live-mode-paths`
    changes with it.
  - `packages/cli/src/serve/repro/format.ts` `redactSecrets` (JWT signature
    stripping into `__redactedJwt`, service-account `SECRET_KEYS` and PEM
    keys) and its callers in `repro/capture.ts`, `repro/replay.ts` and
    `repro/compare.ts`.
  - `packages/cli/src/serve/observed-session/storage-policy.ts`
    (`sanitizeStorageMetadataEntry`, `scrubStorageCustomMetadataRecord`,
    `sanitizeObservedStorageDownloadUrl`: `[REDACTED]` `customMetadata`
    values and download URL credential stripping) and its callers:
    `observed-session/storage-catalog.ts` and
    `observed-session/storage-delta-validation.ts`, the re-exports in
    `packages/cli/src/bridge/client.ts`, `packages/live/src/storage.ts`
    (`copyCustomMetadata`, which scrubs live Storage records at capture) and
    `packages/live/src/storage-session-capture.ts`, and the Studio consumers
    `packages/studio/src/shell/observed-storage-parse.ts` and
    `features/data/LiveObservedStoragePane.tsx`.
- **Capture points that still copy an unused credential are follow-ups under
  decision 2.** The sandbox's `signInWithCredential`, `linkWithCredential` and
  `reauthenticateWithCredential` send OAuth `idToken`, `accessToken`,
  `rawNonce` and `secret` over the worker wire and into MCP arguments, where
  only `providerId` and `signInMethod` are read. `pyric-admin`'s
  `credential.refreshToken(...)` keeps its argument on the credential object,
  which nothing reads; `cert()` already keeps none.
- **Not covered by this record.** These stay as they are:
  - `pyric snapshot` replacing sandbox users' passwords in a fixture meant to
    be committed (`--include-passwords` opts out), and the assurance campaign
    export replacing seeded actors' passwords. Both are credentials Pyric's
    own sandbox seeded, in files written to be shared.
  - The AI proxy masking Pyric's own model provider key. When the proxy
    forwards a request upstream, it adds the key from Pyric's configuration,
    and it masks that key in upstream errors and terminal output
    (`packages/pyric/src/ai/broker/upstream-error-redaction.ts`,
    `gemini-engine.ts`, `packages/cli/src/serve/ai-proxy.ts`,
    `gemini-proxy.ts`, `ai-terminal-blocks.ts`). This isn't observation
    scrubbing. The key is a credential Pyric itself holds and sends, not a
    value the developer's Firebase call returned, so decision 2 already
    keeps it out of records. These sites reuse `redactUrl`, so the export
    stays when its call in `live-terminal-lines.ts` is removed.

## Alternatives considered

- **Scrub at egress only** (repro export, AI prompts, MCP results). This was
  rejected because a repro file and an AI observation are exactly where
  fidelity matters most: the rewritten repro doesn't replay, and the model
  reasons about a marker instead of the value that decided the verdict.
- **Key-name and regex scrubbing.** This was rejected because it misses
  opaque tokens and catches ordinary fields (`pageToken`, `nextPageToken`,
  `tokenType`), and each miss or catch adds a pattern or an exception.
- **Scrub at capture.** This was rejected because it loses the value for
  every reader at once: local rules, seeds, `pyric verify` and replay all see
  the marker.
- **An opt-in redaction flag now.** This was deferred (decision 4). No user
  has asked for it, and it would bring back the code this record removes.
