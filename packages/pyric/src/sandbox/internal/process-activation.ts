/**
 * An activation a host installs in its own process, beside `PYRIC_SANDBOX`.
 *
 * `PYRIC_SANDBOX` activates a process from outside: `pyric sandbox` writes it
 * into a child's environment. A process that runs a host itself has no such
 * variable to read. The Vite plugin is one (#1123): its dev server is the
 * Node host, and the modules it loads for server rendering use the client
 * SDKs and `firebase-admin` in that same process. It installs an activation
 * here instead, and every reader that would read `PYRIC_SANDBOX` (the client
 * SDK bootstrap in `@pyric/cli` and `pyric-admin`'s ambient `initializeApp()`)
 * reads this first when the variable is unset.
 *
 * Nothing is written to `process.env`, so the processes a dev server starts
 * do not inherit it. The slot is a `Symbol.for` global because the readers
 * may load from different package copies (a workspace's sources and an
 * installed `dist`).
 */
import type { Sandbox } from '../types/service.js';

/**
 * The certificate a host in this process serves HTTPS with, which a loopback
 * dial to that host's origin trusts, and no other dial.
 */
export interface HostTrust {
  /** The host's HTTP origin (`https://127.0.0.1:5173`). */
  readonly origin: string;
  /** PEM certificates the dial verifies the host's chain against: its own. */
  readonly ca: readonly string[];
  /** SHA-256 fingerprint (colon-separated hex) of the leaf the host must present. */
  readonly fingerprint256: string;
}

export interface ProcessActivation {
  /** How messages name this activation, where they would name `PYRIC_SANDBOX=<value>`. */
  readonly label: string;
  /** The Node host's base url (`http://127.0.0.1:5173`), at the first call that needs it. */
  readonly host: () => Promise<string>;
  /** The error a client SDK call gets when the host is not the Node host. */
  readonly offHostError: (detail: string) => Error;
  /** The sandbox `pyric-admin`'s ambient `initializeApp()` binds. */
  readonly adminSandbox: () => Sandbox;
  /** The trust a dial to `url` takes, when `url` is on a host here that serves HTTPS. */
  readonly hostTrust?: (url: string) => HostTrust | undefined;
}

const SLOT = Symbol.for('pyric.sandbox.processActivation');
const END_LISTENERS = Symbol.for('pyric.sandbox.processActivationEnd');

type Slot = { [SLOT]?: ProcessActivation; [END_LISTENERS]?: Set<() => void> };

function endListeners(): Set<() => void> {
  const slot = globalThis as Slot;
  slot[END_LISTENERS] ??= new Set();
  return slot[END_LISTENERS];
}

/**
 * Calls `listener` each time an installed activation ends with no replacement:
 * the host in this process is gone for good, so a client that would hold the
 * process while it reconnects (RTDB does) lets it go instead.
 */
export function onProcessActivationEnd(listener: () => void): () => void {
  const listeners = endListeners();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Installs `activation` for this process, replacing the one before it. */
export function installProcessActivation(activation: ProcessActivation): void {
  (globalThis as Slot)[SLOT] = activation;
}

/** Removes `activation` if it is still the installed one; a replacement stays. */
export function clearProcessActivation(activation: ProcessActivation): void {
  const slot = globalThis as Slot;
  const isCurrent = slot[SLOT] === activation;
  if (!isCurrent) return;
  delete slot[SLOT];
  for (const listener of [...endListeners()]) listener();
}

/** The activation installed in this process, if any. */
export function processActivation(): ProcessActivation | undefined {
  return (globalThis as Slot)[SLOT];
}
