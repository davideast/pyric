/**
 * Browser shim — see node-shims/path for context.
 *
 * Two import surfaces hit this:
 *   1. `@inbrowser/agent`'s event-log code (`dist/events/log.js`) —
 *      top-level imports we no-op so the agent loop's in-memory
 *      store can take over.
 *   2. `@pyric/deploy`'s `hosting/walk.ts` — Node-only directory
 *      walker pulled in transitively by the DeployTab's deploy hooks.
 *      The playground never actually walks a local directory in the
 *      browser (it ships a pre-walked file list from esbuild's
 *      metafile instead), so the stubs only need to satisfy module
 *      load. Calling them at runtime in the browser is a bug — they
 *      throw to surface it loudly rather than silently returning
 *      empty data.
 */
export function readFileSync(): string {
  return '';
}
export function appendFileSync(): void {}
export function existsSync(): boolean {
  return false;
}
export function mkdirSync(): void {}
export function readdirSync(): never {
  throw new Error(
    'node-shims/fs.readdirSync: not supported in the browser. Pass a pre-walked file list to hosting.deployFiles instead of `localDir`.',
  );
}
export function statSync(): never {
  throw new Error('node-shims/fs.statSync: not supported in the browser.');
}
export const promises = {
  readFile: async () => '',
  writeFile: async () => {},
  mkdir: async () => {},
};
const fs = {
  readFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  promises,
};
export default fs;
