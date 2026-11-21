---
title: "Remote workstation & reverse-proxy access"
navLabel: "Remote access"
group: "Get started"
section: ""
order: 45
description: "Reach Pyric's sandbox over an SSH tunnel, TLS-terminating reverse proxy, or explicit VPN CIDR without weakening localhost defaults."
---

# Remote workstation & reverse-proxy access

By default, Pyric only trusts loopback connections targeting `localhost`, `127.0.0.1`, or `[::1]` (see ADR 0024 Decision 5 in `docs/decisions/0024-faithful-observation-records.md`). Observation records capture unscrubbed developer traffic including plaintext credentials, state snapshots, and rules source, so DNS rebinding, cross-origin requests, arbitrary `Host` headers, and unauthenticated non-loopback peers are refused automatically.

When your browser runs on a different machine than your dev server, pick one of the three supported topologies below.

## Option 1: SSH tunnel (recommended default)

An SSH local port forward keeps the browser origin on `http://localhost`, preserves `window.isSecureContext === true` (so `ServiceWorker` APIs work out of the box), and requires zero Pyric configuration:

```bash
ssh -L 5173:127.0.0.1:5173 -L 3473:127.0.0.1:3473 user@devbox.example.com
```

Open `http://localhost:5173` locally. No session unlock prompt or extra flags are needed.

## Option 2: TLS-terminating reverse proxy or tunnel (`remoteAccess: true`)

If your proxy runs on the same workstation and forwards local traffic over `127.0.0.1` (`tailscale serve`, `caddy`, `nginx`, or a cloud dev-environment preview URL), explicitly allow the hostname or leading-dot suffix and opt into `remoteAccess`.

### Vite plugin (`@pyric/cli/vite`)

```ts
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    // Leading-dot suffix requires >= 2 DNS labels (e.g. .tailnet.ts.net).
    // Bare wildcards (*, true, .com, .dev) are rejected on /__pyric/*.
    allowedHosts: ['.tailnet.ts.net', 'devbox.example.com'],
  },
  plugins: [
    pyric({
      // Inherits server.allowedHosts when given as an array (never `true`).
      // Defaults to allowPeers: 'loopback', trustProxy: 'loopback', browserUnlock: true.
      remoteAccess: true,
    }),
  ],
});
```

### `pyric sandbox` and `pyric bridge` CLI

```bash
pyric sandbox --hosted --port 3473 \
  --allowed-host .tailnet.ts.net \
  --trust-proxy=loopback

pyric bridge --port 5174 \
  --allowed-host .tailnet.ts.net \
  --trust-proxy=loopback
```

Or configure defaults in `pyric.json` or environment variables:

```json
{
  "allowedHosts": [".tailnet.ts.net"],
  "remoteAccess": {
    "allowPeers": "loopback",
    "trustProxy": "loopback",
    "browserUnlock": true
  }
}
```

| Environment variable | Equivalent setting |
| --- | --- |
| `PYRIC_ALLOWED_HOSTS` | Comma-separated hostnames or leading-dot suffixes (`>= 2` labels). |
| `PYRIC_ALLOW_REMOTE_PEERS` | `loopback`, comma-separated IP/CIDR list (`100.64.0.0/10`), or `any`. |
| `PYRIC_TRUST_PROXY` | `false`, `loopback`, or comma-separated proxy IP/CIDR list. |

Note that Vite's `server.allowedHosts: true` is deliberately ignored on `/__pyric/*` even when `remoteAccess: true` is configured. List every allowed hostname or leading-dot suffix explicitly.

### One-click browser pairing (`/__pyric/unlock`)

With `remoteAccess` enabled, every request on a non-loopback `Host` header or from a non-loopback TCP peer must hold the per-boot session capability token. There is no unauthenticated remote bypass flag.

On startup, Pyric prints the pairing path containing the token in the URL fragment (never in a query string, so proxy logs and `Referer` headers never see it):

```text
  unlock   open /__pyric/unlock#code=<per-boot-token> on the allowed remote host to pair a browser
```

1. Open `https://box.tailnet.ts.net/__pyric/unlock#code=<token>` in your browser (or visit `/__pyric/unlock` and paste the token manually).
2. The page immediately scrubs `#code=` via `history.replaceState` before sending a same-origin `POST /__pyric/unlock`.
3. Pyric sets a port-scoped `HttpOnly; SameSite=Strict; Path=/__pyric` session cookie (`__pyric_session_<port>`), appending `; Secure` whenever the request arrived over HTTPS or a trusted proxy sending `X-Forwarded-Proto: https`.
4. Subsequent browser loads on `/__pyric/init.json`, `WS /__pyric/sandbox`, `EventSource('/__pyric/events')`, Studio UI (`/__pyric/ui/studio/`), avatars, flow modules, and Storage byte routes carry the cookie automatically.
5. Call `POST /__pyric/logout` from the same origin to revoke the browser cookie (`Max-Age=0`).

## Option 3: Direct LAN or VPN CIDR (`allowPeers`)

When clients reach the workstation's TCP socket directly over a VPN or private network (`10.x`, `100.64.0.0/10`, `fd7a::/16`), supply an explicit CIDR allowlist alongside the allowed `Host` header. Avoid wildcard binds without a tight `allowPeers` rule:

```bash
pyric sandbox --hosted --host 0.0.0.0 --port 3473 \
  --allowed-host devbox.example.com \
  --allow-remote-peers=100.64.0.0/10
```

Leave `trustProxy` off (`false`) for direct connections so remote peers cannot spoof `X-Forwarded-Proto` or `X-Forwarded-Host`.

Even when bound to `0.0.0.0`, the Auth and RTDB REST endpoints (`rest-auth-rtdb.ts`) enforce `allowPeers` and require the per-boot session token for all non-loopback requests.

## Host pattern rules

Every entry in `allowedHosts` follows strict Vite-aligned rules:

- Exact hostname: `devbox.example.com`, optional explicit port `devbox.example.com:5173`.
- Leading-dot subdomain suffix: `.tailnet.ts.net` (matches `box.tailnet.ts.net` and `a.b.tailnet.ts.net`; rejects bare `tailnet.ts.net` and `eviltailnet.ts.net`).
- At least two DNS labels are required after the leading dot. Single-label suffixes (`.com`, `.dev`, `.local`, `.`), embedded wildcards (`*.example.com`), `*`, `true`, `0.0.0.0`, `::`, and `::ffff:0:0` are always rejected.

## Live mode remains separately fenced

Because [Live mode](../observe/live-mode.md) observes real Firebase project traffic, remote TCP peers are rejected even when `allowPeers` is set unless you pass the second explicit flag `pyric-live --allow-remote-live` (or `allowLiveRemotePeers: true` in `remoteAccess`).

## Plain HTTP `Secure Context` limitation

Browsers treat `http://localhost` as a Secure Context (`window.isSecureContext === true`), but treat plain `http://devbox.example.com:5173` as **non-secure** (`window.isSecureContext === false`):

- **Cookies travel in cleartext** over plain HTTP (`; Secure` is omitted so the browser can store the cookie over HTTP). Use an HTTPS reverse proxy or an SSH tunnel on shared networks.
- **`navigator.serviceWorker` is unavailable** over plain HTTP non-localhost origins. Features backed by service workers (`pyric/messaging/sw`, `pyric/storage/sw`) require HTTPS or an SSH tunnel to `http://localhost`.
- **`crypto.randomUUID()` fallback:** Pyric falls back to `crypto.getRandomValues` for UUID v4 generation in Auth, Messaging, and Storage so plain-HTTP remote tabs continue working without `TypeError: crypto.randomUUID is not a function`.

## Security invariants preserved (ADR 0024 Decision 5)

- `GET /__pyric/unlock` rejects query-string tokens (`?token=`, `?code=`) with HTTP `400` and `Cache-Control: no-store`.
- Redirect targets (`?next=`) only accept single-leading-slash relative paths, blocking open redirects (`//evil.example`, `https://evil.example`, `javascript:`, backslashes, and `..` segments).
- `POST /__pyric/unlock` caps bodies at `1024` bytes (`413`), requires `application/json` and strict same-origin headers (`403`), verifies tokens in constant time, and throttles brute-force guesses (`429` with `Retry-After`).
- Session cookies stay scoped per listening port (`__pyric_session_<port>`) so a cookie issued on `:5173` never authenticates a second dev server on `:5174`.
- See [Vite development setup](./vite.md) and [Node host mode](./node-host.md) for server lifecycle details.
