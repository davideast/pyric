/** Browser shim — see node-shims/path for context. */
export function readFileSync(..._args: unknown[]): never {
  throw new Error('node-shims/fs: readFileSync() called in browser');
}
