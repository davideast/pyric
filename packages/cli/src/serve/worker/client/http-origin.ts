/** The HTTP origin that serves a url: a socket's `wss:` reads as `https:`, its `ws:` as `http:`. */
export function httpOriginOf(url: string | URL): string {
  const parsed = new URL(url);
  const isSecure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
  parsed.protocol = isSecure ? 'https:' : 'http:';
  return parsed.origin;
}
