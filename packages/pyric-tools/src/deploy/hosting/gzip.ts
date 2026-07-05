/**
 * gzip via `CompressionStream('gzip')`. Built-in in Node 20+ and
 * every modern browser, so no Node/browser split is needed.
 *
 * Hosting requires `Content-Type: application/octet-stream` for the
 * upload step and the manifest hash MUST be the SHA-256 of the
 * gzipped bytes — not the raw bytes — so this helper is the one
 * normalization point.
 */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  // TS 5.7's `Uint8Array<TBuffer>` generic doesn't unify with the
  // writer's `BufferSource` overload; runtime accepts a Uint8Array.
  void writer.write(bytes as BufferSource);
  void writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}
