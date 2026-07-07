/**
 * isomorphic-git expects Node's `Buffer` in the browser bundle.
 * Import this module once before any git operation in client code.
 */
import { Buffer } from 'buffer/';

let installed = false;

export function ensureBufferPolyfill(): void {
  if (installed) return;
  if (typeof globalThis.Buffer === 'undefined') {
    (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
  }
  installed = true;
}
