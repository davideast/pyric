/**
 * Browser shim — see node-shims/path for context.
 *
 * `@inbrowser/agent`'s event-log code (`dist/events/log.js`) imports
 * these at module load. The Playground's in-memory store takes over,
 * so the shims satisfy module loading and fail loudly if directory
 * traversal is attempted in the browser.
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
  throw new Error('node-shims/fs.readdirSync: not supported in the browser.');
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
