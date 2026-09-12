/**
 * Listener owners, derived on the page rather than in the worker.
 *
 * The in-page sandbox attaches a listener in the same context as the call, so
 * it reads the calling frame off its own stack, takes the `owner` the caller
 * passed, and turns an element owner into a selector against the live
 * document. On a served page none of that is true where the attach happens:
 * the sandbox runs in a SharedWorker, the stack there belongs to the worker
 * bundle, the caller's options never crossed the port, and there is no DOM to
 * select against.
 *
 * So the client derives the owners here, where the call actually happened, and
 * sends them with the subscribe message. The derivation is pyric's own,
 * reached through `pyric/sandbox/internal`, so a served page and an in-page
 * sandbox produce the same owners for the same call.
 */
import {
  callerFrameFromStack,
  listenerAttributionEnabled,
  tagOwnerFor,
} from 'pyric/sandbox/internal';
import type { ListenerOwner } from 'pyric/sandbox';

/** The listen options a caller may pass, as far as attribution is concerned. */
export interface OwnerBearingOptions {
  readonly owner?: unknown;
}

/**
 * The directory this client is served from.
 *
 * `callerFrameFromStack` skips pyric's own frames, but between the application
 * and pyric there are also this client's frames, which are the CLI's and which
 * pyric cannot recognize. They all share one directory: under source that is
 * `.../serve/worker/client`, and on a served page it is the directory the SDK
 * bundle is served from, which the application's own modules are never in.
 * Empty when a bundler erased `import.meta.url`, in which case the filter
 * falls back to pyric's own.
 */
const CLIENT_ROOT = clientRoot();

function clientRoot(): string {
  let here: string | undefined;
  try {
    const url = (import.meta as { url?: unknown }).url;
    if (typeof url === 'string') here = url;
  } catch {
    here = undefined;
  }
  if (here === undefined) return '';
  const directory = here.slice(0, here.lastIndexOf('/'));
  return directory.startsWith('file://') ? directory.slice('file://'.length) : directory;
}

/** A stack with this client's own frames removed, for pyric to read. */
function callerStack(stack: string): string {
  if (CLIENT_ROOT.length === 0) return stack;
  return stack.split('\n').filter((line) => !line.includes(CLIENT_ROOT)).join('\n');
}

/**
 * The owners for a listener the page is about to open, in the same order the
 * in-page path records them: the calling frame first, then the explicit owner.
 * `undefined` when neither is known, so the subscribe message omits the field.
 *
 * Frame capture follows the attribution switch exactly as the in-page path
 * does. The explicit owner is not gated: the caller asked for it by name.
 *
 * Every owner returned is plain JSON. An element owner is already reduced to a
 * selector by `tagOwnerFor`, so no DOM node is ever put on the wire.
 */
export function pageListenerOwners(
  options: OwnerBearingOptions | undefined,
): ListenerOwner[] | undefined {
  const owners: ListenerOwner[] = [];
  const frame = pageCreationFrame();
  if (frame !== undefined) owners.push(frame);
  const explicit = tagOwnerFor(options?.owner as Parameters<typeof tagOwnerFor>[0]);
  if (explicit !== undefined) owners.push(explicit);
  if (owners.length === 0) return undefined;
  return owners;
}

/** The application frame that opened the listener, read from this call's stack. */
function pageCreationFrame(): ListenerOwner | undefined {
  if (!listenerAttributionEnabled()) return undefined;
  const stack = new Error().stack;
  if (typeof stack !== 'string') return undefined;
  return callerFrameFromStack(callerStack(stack));
}
