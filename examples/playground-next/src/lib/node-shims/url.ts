/** Browser shim — see node-shims/path for context. Returns a
 *  harmless string so top-level resolver init doesn't throw. */
export function fileURLToPath(url: string | URL): string {
  const s = typeof url === 'string' ? url : url.href;
  return s.replace(/^file:\/\//, '');
}
export function pathToFileURL(p: string): URL {
  return new URL(`file://${p}`);
}
const url = { fileURLToPath, pathToFileURL };
export default url;
