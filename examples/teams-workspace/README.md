# Orbit teams workspace

A regular Firebase/React collaboration app with channels, threads, reactions, files, search and an AI assistant. Pyric is configured only in `vite.config.ts`: the development plugin injects its sandbox, runtime chip and agent bridge. Browser application modules import `firebase/*`, never Pyric internals.

## Run locally

From the repository root:

```sh
bun install --frozen-lockfile
bash scripts/build.sh --packages-only
bun examples/teams-workspace/serve.ts
```

Open http://localhost:5217. The port is strict, so another server cannot silently push this app to a different port. `TEAMS_PORT` overrides it.

The first visit starts signed out. Create an account or use Google sign-in. Firebase Auth manages subsequent session restoration. The account area has Sign out; impersonation belongs exclusively to the injected Pyric chip.

`seed.json` contains development messages and matching Auth identities for David, Alice, Marcus and Avery. Their UIDs match message authors; their profile photos match the team roster. Use the chip to switch between them, or sign in with `<name>@orbit.example` and the local demo password `orbit-demo`. Seeding does not sign anyone in. Security rules live in normal Firebase rules files. Firestore handles messages, threads and reactions; RTDB handles typing, presence and receipts; Storage handles attachments. The app never seeds or changes sandbox rules itself.

## Share the Node host across browsers

After the install and build above, run Orbit through its normal Vite dev script:

```sh
TEAMS_HOSTED=1 bun run --cwd examples/teams-workspace dev
```

The Vite executable must use Node 22.15 or later on your `PATH`. Open
http://localhost:5217 in two browsers, sign in with different seeded users, and
send messages or upload an attachment. Both browsers share the Node sandbox;
Studio at http://localhost:5217/__pyric/ui/studio sees the same data. State
survives server restarts in this example's `.pyric/state/` directory.

Omit `TEAMS_HOSTED` to retain the default SharedWorker mode. Stop the existing
server before switching modes. No Firebase application code changes are needed.

## AI assistant

With `TEAMS_HOSTED=1`, the Node engine calls the configured AI upstream directly.
SharedWorker mode uses `/__pyric/ai-proxy` to reach the same upstream. Both modes
honor the Vite plugin's `ai.model` and `ai.proxyUpstream` settings.

Choose **AI assistant** in the app navigation to summarize the selected channel, find explicit next steps, draft a reply, or ask your own question. Answers stream into the conversation. Ask follow-up questions, copy an answer, regenerate the latest answer, or start a new chat. Replies remain private to this browser visit; they are not posted to a channel or stored in Firebase. Reloading or changing the signed-in identity clears chat history.

Each chat freezes its channel context when the first question is sent: up to 40 recent loaded messages, at most 1,200 text characters per message and 10,000 message-text characters in total. Attachment content is excluded. Follow-ups and regeneration reuse that snapshot; start a new chat to capture newer activity. The assistant generates text only and cannot send messages, change files, or perform actions. Review answers before sharing them.

The app calls Firebase AI Logic through `firebase/ai`, requesting `gemini-2.5-flash`. During development, the Pyric Vite configuration routes these calls to local Ollama using `ai: { model: "ornith:9b" }`. Run Ollama with that model available at the default endpoint, `http://localhost:11434/v1`, to receive local answers. An unavailable server or model produces an inline error with a retry action. The existing injected Pyric chip remains the developer UI; this example adds no AI-specific chip views.

## Demo scenarios

A separate panel can simulate conversation activity, 80 writes over roughly eight seconds, validation denials, and queries needing Firestore indexes or RTDB `.indexOn`. These use ordinary Firebase calls. Bursts exceed the default write threshold; custom thresholds may require different workloads.

Open the Pyric chip to inspect data, requests, usage and incidents. Its identity controls are outside the app. The Vite plugin owns the runtime lifecycle and bridge.

## Production

`bun run --cwd examples/teams-workspace build` uses real Firebase imports. Configure `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_DATABASE_URL`, and `VITE_FIREBASE_STORAGE_BUCKET` before a real deployment. The checked-in values are local demo placeholders; no production project is configured.

Production assistant requests use real Firebase AI Logic and Gemini, not the development Ollama route. The Firebase project must be set up for Firebase AI Logic with the Google AI backend before the assistant can work in production.

## Tailscale

For optional remote access, supply your MagicDNS hostname through `TEAMS_REMOTE_HOST` when starting the server. `TEAMS_REMOTE_PORT` defaults to `8457` and controls the HTTPS hot-reload connection. The server remains bound to loopback.

Set `TEAMS_REMOTE_HOST` to the hostname reported by `tailscale status`, then run:

```sh
bun examples/teams-workspace/serve.ts
# In another terminal:
tailscale serve --bg --https=8457 http://127.0.0.1:5217
```

Use the HTTPS hostname for a valid certificate and secure browser APIs. Keep the local server running. Remove only this route with `tailscale serve --https=8457 off`.

If the page stalls, inspect startup and socket reports without connecting to the
sandbox WebSocket (run from the repository root):

```sh
node packages/cli/dist/cli/index.js serve diagnostics --url http://127.0.0.1:5217 --json
```

This includes reports from remote browsers reaching the same server. Pass the
public HTTPS URL instead to check the Tailscale HTTP route too. See
[connection diagnostics](../../docs/connection-diagnostics.md) for the report
fields and the browser-local fallback when HTTP also fails.

## Mention notifications

Install the example's Functions dependencies once, then start Node-hosted Orbit:

```sh
bun install --cwd examples/teams-workspace/functions --frozen-lockfile
TEAMS_HOSTED=1 bun run --cwd examples/teams-workspace dev
```

1. Open http://127.0.0.1:5217 in two **separate browser profiles**.
2. Sign in as `alice@orbit.example` in one and `david@orbit.example` in the other (password `orbit-demo`).
3. In both profiles, choose **Notifications → Enable notifications** and allow browser notifications.
4. As David, send `@alice please review this` in a channel. Alice gets a mention in her Notifications panel; David does not. Select it to open that channel.
5. Hide all Alice windows, keeping David visible, and send another mention. Alice's real Service Worker receives it and requests an OS notification. OS/browser notification settings must also allow the banner.
6. Reload Alice's page: notifications re-enable automatically. Sign out, sign in as Marcus, and enable notifications. New `@alice` mentions must not appear in Marcus's panel; `@marcus` mentions must.

The backend uses an RTDB `onValueCreated` trigger and the Admin Messaging SDK.
The request contains only a channel; the function reads the saved message,
resolves `@uid` mentions, and reads private per-user device tokens. It ignores
self-mentions and deduplicates repeated mentions in one message. Rules prevent
forged message authors, reading another user's tokens, and queuing requests as
another user. Sign-out revokes this browser's token before ending the session.
Use one signed-in identity per browser profile, as the Messaging installation is
shared by that profile's tabs. The UI retains the latest 50 received mentions
for this visit; it is not a persistent inbox.

The Pyric identity chip can switch the active account in one profile. Orbit
remembers notification opt-in separately for each account and restores it when
you return. Switching accounts revokes the old token; it does not try to delete
the previous account's private database path using the new identity. The backend
prunes invalid token mappings when sending. The explicit app sign-out button
also removes the current account's mapping before signing out.

For a phone checkpoint, use regular Chrome on the phone as Alice and another
device or regular browser profile as David. Enable notifications only on Alice's
phone, then send `@alice review this` from David. Self-mentions are intentionally
ignored. An Incognito window can be the sender, but Chrome does not support
notifications in private browsing. Android's Chrome notification permission does
not replace the permission for this specific site: check the address bar's site
permissions for the Tailscale HTTPS origin.

### Device display checkpoint

Use this checkpoint before debugging background delivery. It exercises the
browser's native notification display API directly, without sending a message
through Pyric or FCM.

1. Reload Orbit in regular Chrome on your phone at the Tailscale HTTPS address.
2. Sign in, open **Notifications**, and enable notifications if needed.
3. Tap **Test device notification**. The status should say **Browser accepted the
   notification. Check your device’s notifications.** A rejection is shown in the
   panel and the button remains available for retry.
4. Check Android's notification shade for **Orbit device notification test**.
   Record separately whether a heads-up banner appeared: Android notification
   channel settings and Do Not Disturb can suppress banners.
5. Tap the notification. Orbit should open the **design-studio** channel.

The success message only confirms that `showNotification()` resolved. It does
not prove visible display, remote delivery, or wakeup with a closed tab. If the
browser accepts the request but nothing appears, check site permissions,
Chrome's Android notification settings, and Do Not Disturb before investigating
the message transport.

Setup displays its current stage and stops waiting after ten seconds, with a
retry button. An interrupted or abandoned attempt cannot later publish its
token from a completed worker registration. If connectivity fails during token
revocation, new setup waits for that revocation to finish before replacing the
token, so a late deletion cannot revoke the new account's token. Reload the page
once after updating this demo to load the revised notification lifecycle.

SharedWorker remains supported: omit `TEAMS_HOSTED`. Its sandbox belongs to the
browser profile, so separate profiles do not share a workspace. The notification
backend connects through that profile's bridge. Node mode is the checkpoint for
cross-profile delivery.

These are **local simulated FCM deliveries**, not calls to Google's FCM service.
The sandbox cannot wake a closed browser. Real Firebase use requires project
configuration (including `VITE_FIREBASE_APP_ID` and
`VITE_FIREBASE_MESSAGING_SENDER_ID`), `VITE_FIREBASE_VAPID_KEY`, notification
permission, HTTPS, and a
deployed function. Neither deployment nor production Web Push is exercised by
these local checks. Notification request failures do not roll back a sent chat
message; they are reported in the console. This demo does not provide a retry
queue for notification requests or a durable notification inbox.

Run focused verification with Node 22.15+ on `PATH`:

```sh
bun run --cwd examples/teams-workspace typecheck
bun run --cwd examples/teams-workspace test:notifications
TEAMS_HOSTED=0 bun run --cwd examples/teams-workspace test:notifications
bun run --cwd examples/teams-workspace build
```

Tests use a disposable copy on port 53917 and stop its server and Functions
child afterward. The background test verifies the real Service Worker callback;
it supplies hidden visibility deterministically and does not certify OS banners.

The native display check uses a disposable **headed** Chromium profile and checks
`ServiceWorkerRegistration.getNotifications()` without replacing the display
API. Run it on a machine with a desktop session:

```sh
ORBIT_NATIVE_NOTIFICATIONS=1 bun run --cwd examples/teams-workspace test:notifications -g 'device display test'
TEAMS_HOSTED=0 ORBIT_NATIVE_NOTIFICATIONS=1 bun run --cwd examples/teams-workspace test:notifications -g 'device display test'
```

It is explicitly skipped in the default headless suite: headless Chromium in
this environment rejects native display despite a granted permission override.
The regular suite checks missing setup and browser rejection/retry; its retry
check replaces only the external display API. Neither automated check certifies
an Android banner. The phone checkpoint above supplies that evidence.
