/**
 * Re-anchor a bridge WebSocket URL to the page's own origin.
 *
 * `pyric dev` / the vite plugin bake their OWN host into the bridge URL it
 * sends the page (e.g. `ws://localhost:5173/__pyric/sandbox`). But the page may
 * have been loaded over a different host (Tailscale, a LAN IP) or scheme
 * (`https` via `tailscale serve`, which then requires `wss`). Connecting to the
 * baked `localhost` from a remote tab dials the WRONG machine (the client's own
 * localhost), so the WS fails.
 *
 * Keep only the PATH from the server's URL and rebuild the scheme + host from the
 * page's `location`. The bridge is always mounted on the same server that served
 * the page, so the page's origin is the correct target wherever it is reached,
 * with no plugin configuration. This also sidesteps the localhost / 127.0.0.1 /
 * ::1 family ambiguity, because the browser dials the exact host it loaded from.
 *
 * Pure (location is injected) so it is unit-testable. Returns `raw` unchanged if
 * it cannot be parsed.
 */
export function toPageOriginWsUrl(
  raw: string,
  loc: { href: string; protocol: string; host: string },
): string {
  try {
    const rawUrl = new URL(raw, loc.href);
    const locUrl = new URL(loc.href);
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';

    const hasExplicitLocPort = locUrl.port.length > 0;
    const hasExplicitRawPort = rawUrl.port.length > 0;
    const shouldPreserveRawPort = hasExplicitLocPort && hasExplicitRawPort;
    const hostTarget = shouldPreserveRawPort ? `${locUrl.hostname}:${rawUrl.port}` : locUrl.host;

    return `${scheme}//${hostTarget}${rawUrl.pathname}`;
  } catch {
    return raw;
  }
}
