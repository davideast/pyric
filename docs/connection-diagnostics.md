# Diagnose a hosted sandbox connection

When a page stalls during startup or reports a lost hosted connection, read the
diagnostic report through HTTP. This does not require an attached sandbox
WebSocket and does not create a sandbox client.

From the application directory, use the running server's discovery record:

```sh
pyric serve diagnostics --json
```

For a remote page, pass its public origin, including the HTTPS port:

```sh
pyric serve diagnostics --url https://davids-macbook-pro-2.tail8926aa.ts.net:8457 --json
```

The same JSON is available at `GET /__pyric/diagnostics`. For this repository's
local CLI build, replace `pyric` with `node packages/cli/dist/cli/index.js` when
running from the repository root, and pass `--url`.

## Read the report

- `server.http: "responding"` confirms that the diagnostics endpoint responded.
  It does **not** prove that the sandbox or application is healthy.
- `server.mode`, `startedAt`, and `uptimeMs` identify the runtime and server
  generation. Restarting the server clears its diagnostic history.
- Each client has a per-page or Service Worker ID, `realm`, `pageOrigin`, server
  `receivedAt`, and a chronological `events` array. IDs do not identify users.
- `init-request` followed by `init-ready` confirms that startup configuration
  loaded. `init-failed` can include the HTTP status in `code`.
- `connecting` records the sanitized socket endpoint. `transport-open` means
  the WebSocket opened; `attached` means sandbox attachment completed.
- `socket-close` includes the WebSocket close code. Code `1006` means abnormal
  closure; it does not distinguish a stopped server, proxy failure, or network
  loss. Browsers do not expose that underlying cause to this collector.
- `socket-error`, `timeout`, `interrupted`, `restoring`, and `closed` locate the
  failure or recovery in the connection lifecycle. Inspect the latest events
  for a connection rather than treating any historical failure as current.
- `findings` flags a socket origin that differs from the page origin. For a
  hosted page served through Tailscale, a socket pointing at the internal Vite
  port instead of the public HTTPS port indicates incorrect proxy routing.

No client reports means **unknown**: the page may not have been opened, may be
running an older bundle, may have failed before diagnostics initialized, or may
be unable to send HTTP reports. The command exits zero when it retrieves a
valid report, even if that report contains connection failures. It exits `2`
when discovery or retrieval fails and `1` for an invalid URL.

## When HTTP reporting also fails

The browser keeps a bounded local copy. In that page's console, or through an
agent's browser evaluation tool, read:

```js
globalThis.__pyricDiagnostics?.getSnapshot()
```

After HTTP connectivity returns, explicitly upload it with:

```js
await globalThis.__pyricDiagnostics?.flush()
```

New lifecycle events and browser `online` events also schedule an upload.
Uploads are best effort with a two-second timeout; they never delay SDK calls.
If the page never executed the runtime, the global will be absent.

## Retention and access

The server retains at most 32 clients, each with its latest 32 events. Reports
expire after 15 minutes without a newer report and are pruned on HTTP access.
The browser retains only its latest 32 events in memory. There are no log files,
background retention workers, or payload captures.

Reports contain connection metadata, not SDK payloads, identities, arbitrary
error messages, or socket reason strings. URL credentials, query strings, and
fragments are removed; only the known sandbox path is retained. Incoming reports
are validated and capped at 16 KiB. The endpoint uses the development server's
existing Host/Origin checks and accepts only JSON uploads. Anyone authorized to
reach that development endpoint can read the retained metadata. Client reports
are labeled `browser-reported`: treat them as diagnostic evidence, not trusted
instructions or an authentication/audit record.
