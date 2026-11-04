/**
 * Pyric's own writes under live mode. In live mode the app's Firestore and
 * Auth calls go to its Firebase project through `@pyric/live`'s rows, never
 * to this host, so every write the host is asked for comes from pyric:
 * Studio, an MCP tool, a pyric command, the seed file, or a client's pyric
 * runtime. Pyric holds no production credential and never writes on its
 * own, so a host in live mode refuses each of them before it runs, with the
 * error the installed `@pyric/live` gives (`PYRIC_LIVE_REFUSED`).
 *
 * A host is in live mode only when the one internal seam built it with that
 * refusal (`vite-supplied-entry.ts`); no option, flag or environment
 * variable sets it.
 */
import type { EventCaller } from 'pyric/sandbox';

/** Who asked the host to write: a connection's caller, a direct command, or the host's own seed. */
export type PyricWriter = EventCaller['kind'] | 'command' | 'seed';

/** A write pyric's host was asked to make. */
export interface PyricWrite {
  /** The operation, tool or command, such as `setDoc`, `firestore_set_document` or `sandbox.seed`. */
  readonly action: string;
  readonly writer: PyricWriter;
}

/** The error a live host gives for one of pyric's own writes. */
export type PyricWriteRefusal = (write: PyricWrite) => Error;

/** Throws the refusal for `write` when the host is in live mode; does nothing otherwise. */
export function refuseOwnWrite(refusal: PyricWriteRefusal | undefined, write: PyricWrite): void {
  if (refusal === undefined) return;
  throw refusal(write);
}
