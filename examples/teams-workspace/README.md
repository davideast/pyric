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
