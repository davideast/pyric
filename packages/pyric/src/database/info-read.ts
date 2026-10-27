import { isInfoPath } from './writable-path.js';

/**
 * The rejection of a one-shot `get()` of a location under `/.info`: the SDK
 * sends the read to the database, which refuses the `.info` token (capture
 * rtdb-modular-info-write-validation, behavior.getConnected). A listener on
 * the path is answered by the client and is not affected.
 *
 * Every plane's `get` calls {@link assertGettablePath}: the in-page sandbox
 * and admin handle, the CLI/Studio worker client, and pyric-admin's local arm.
 * pyric-admin's remote arm relays to the worker host, whose `get` is the first.
 */
export function invalidInfoRead(): Error {
  return new Error('Invalid token in path');
}

/** Throw {@link invalidInfoRead} when a one-shot `get()` targets `path` under `/.info`. */
export function assertGettablePath(path: string): void {
  if (isInfoPath(path)) throw invalidInfoRead();
}
