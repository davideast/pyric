/**
 * Re-anchor a bridge WebSocket URL to the page's own origin.
 *
 * `pyric sandbox` / the vite plugin bake their OWN host into the bridge URL it
 * sends the page (e.g. `ws://localhost:5173/__pyric/sandbox`). But the page may
 * have been loaded over a different host (Tailscale, a LAN IP) or scheme
 * (`https` via `tailscale serve`, which then requires `wss`). Connecting to the
 * baked `localhost` from a remote tab dials the WRONG machine (the client's own
 * localhost), so the WS fails.
 *
 * Hosted callers select `page-origin`: retain the path and use the page's full
 * public origin, including a reverse proxy's port. The default `bridge-port`
 * preserves an explicit server port for existing two-server development setups. This also sidesteps the localhost / 127.0.0.1 /
 * ::1 family ambiguity, because the browser dials the exact host it loaded from.
 *
 * Pure (location is injected) so it is unit-testable. Returns `raw` unchanged if
 * it cannot be parsed.
 */
export function toPageOriginWsUrl(
  raw: string,
  loc: { href: string; protocol: string; host: string },
  routing: 'page-origin' | 'bridge-port' = 'bridge-port',
): string {
  try {
    const rawUrl = new URL(raw, loc.href);
    const locUrl = new URL(loc.href);
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';

    const hasExplicitLocPort = locUrl.port.length > 0;
    const hasExplicitRawPort = rawUrl.port.length > 0;
    const usesSeparateBridgePort = routing === 'bridge-port';
    const shouldPreserveRawPort = usesSeparateBridgePort && hasExplicitLocPort && hasExplicitRawPort;
    const hostTarget = shouldPreserveRawPort ? `${locUrl.hostname}:${rawUrl.port}` : locUrl.host;

    return `${scheme}//${hostTarget}${rawUrl.pathname}`;
  } catch {
    return raw;
  }
}
