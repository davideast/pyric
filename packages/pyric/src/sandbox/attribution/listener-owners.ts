/**
 * Deriving a listener's owners at the moment it attaches.
 *
 * Two owners can be known at attach time and no later:
 *
 * - the creation `frame`, read from a stack captured on the attaching call
 *   stack. Once the listener is registered the caller's stack is gone, so
 *   this has to happen here, and it costs exactly one `Error` construction
 *   per attach, never one per delivery.
 * - the caller's `tag`, taken from the `owner` listen option. That option is
 *   pyric's own extension to `SnapshotListenOptions` and `ListenOptions`; the
 *   Firebase SDKs have no such field and ignore it.
 *
 * The third owner kind, `regions`, is a property of a delivery rather than of
 * an attach, and lives in `effect-regions.ts`.
 */

import type { ListenerOwner } from '../types/events.js';
import { listenerAttributionEnabled } from './attribution-mode.js';
import {
  isSelectableElement,
  ownerSelectorFor,
  tagNameOf,
  type SelectableElement,
} from './element-selector.js';

/**
 * What a caller may pass as a listener's `owner`: a name, or the DOM element
 * the listener feeds.
 */
export type ListenerOwnerHint = string | SelectableElement;

/**
 * Pyric's own root directory, derived from this module's own location.
 *
 * A frame is "pyric's own" when its path starts here. Deriving the root from
 * `import.meta.url` rather than hardcoding `packages/pyric` makes the test
 * work for both trees the mirror ships from: under source this resolves to
 * `.../packages/pyric/src`, and under a build to `.../pyric/dist`. Either way
 * it is the directory that contains every pyric file that could appear on the
 * stack between the caller and the attach.
 */
const PYRIC_ROOT = pyricRoot();

function pyricRoot(): string {
  // This file sits at `<root>/sandbox/attribution/listener-owners.{ts,js}`,
  // so the root is three path segments up. A bundler that inlines this module
  // into one artifact leaves `import.meta.url` undefined; there is then no
  // pyric directory to recognize, and frame filtering falls back to the
  // `node_modules` test alone.
  const here = importMetaUrl();
  if (here === undefined) return '';
  const withoutFile = here.slice(0, here.lastIndexOf('/'));
  const withoutAttribution = withoutFile.slice(0, withoutFile.lastIndexOf('/'));
  const withoutSandbox = withoutAttribution.slice(0, withoutAttribution.lastIndexOf('/'));
  return stripFileScheme(withoutSandbox);
}

/** This module's own URL, or `undefined` inside a bundle that erased it. */
function importMetaUrl(): string | undefined {
  try {
    const url = (import.meta as { url?: unknown }).url;
    if (typeof url !== 'string') return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function stripFileScheme(url: string): string {
  if (url.startsWith('file://')) return url.slice('file://'.length);
  return url;
}

/** A frame inside pyric itself, or inside an installed dependency. */
function isInternalFrame(file: string): boolean {
  if (file.includes('/node_modules/')) return true;
  if (PYRIC_ROOT.length > 0 && file.startsWith(PYRIC_ROOT)) return true;
  return false;
}

const FRAME_WITH_FUNCTION = /^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/;
const FRAME_WITHOUT_FUNCTION = /^\s*at\s+(.+):(\d+):(\d+)\s*$/;

/**
 * Parse one V8 stack line into a `frame` owner. Both formats the runtime
 * emits are handled: `at fn (/path/file.ts:12:5)` and `at /path/file.ts:12:5`.
 * Anything else (a header line, a `native` frame, a runtime with a different
 * stack format) returns `undefined` and is skipped.
 */
export function parseStackFrame(line: string): ListenerOwner | undefined {
  const named = FRAME_WITH_FUNCTION.exec(line);
  if (named) {
    const owner: ListenerOwner = {
      kind: 'frame',
      file: stripFileScheme(named[2]!),
      line: Number(named[3]),
      column: Number(named[4]),
      function: named[1]!,
    };
    return owner;
  }
  const bare = FRAME_WITHOUT_FUNCTION.exec(line);
  if (bare) {
    const owner: ListenerOwner = {
      kind: 'frame',
      file: stripFileScheme(bare[1]!),
      line: Number(bare[2]),
      column: Number(bare[3]),
    };
    return owner;
  }
  return undefined;
}

/**
 * The first frame outside pyric's own files, read from `stack`. Exported for
 * the test, which supplies a synthetic stack rather than a real one.
 */
export function callerFrameFromStack(stack: string): ListenerOwner | undefined {
  for (const line of stack.split('\n')) {
    const frame = parseStackFrame(line);
    if (frame === undefined) continue;
    if (frame.kind !== 'frame') continue;
    if (isInternalFrame(frame.file)) continue;
    return frame;
  }
  return undefined;
}

/**
 * Capture the frame that created a listener. `undefined` when attribution is
 * off, when the runtime produced no stack, or when every frame on it belongs
 * to pyric.
 */
export function captureCreationFrame(): ListenerOwner | undefined {
  if (!listenerAttributionEnabled()) return undefined;
  const stack = new Error().stack;
  if (typeof stack !== 'string') return undefined;
  return callerFrameFromStack(stack);
}

/**
 * Build the `tag` owner from whatever the caller passed as `owner`. A string
 * is the name verbatim; an element contributes its tag name plus a selector
 * that finds it again. Unlike frame capture this is not gated on the
 * attribution switch: the caller asked for it by name.
 */
export function tagOwnerFor(hint: ListenerOwnerHint | undefined): ListenerOwner | undefined {
  if (hint === undefined) return undefined;
  if (typeof hint === 'string') {
    if (hint.length === 0) return undefined;
    return { kind: 'tag', name: hint };
  }
  if (!isSelectableElement(hint)) return undefined;
  return { kind: 'tag', name: tagNameOf(hint), element: ownerSelectorFor(hint) };
}

/**
 * Every owner known at attach time, in a stable order: frame first, then tag.
 * Returns `undefined` rather than an empty array so an event with no
 * attribution omits the field entirely.
 */
export function listenerAttachOwners(
  hint?: ListenerOwnerHint,
): ListenerOwner[] | undefined {
  const owners: ListenerOwner[] = [];
  const frame = captureCreationFrame();
  if (frame !== undefined) owners.push(frame);
  const tag = tagOwnerFor(hint);
  if (tag !== undefined) owners.push(tag);
  if (owners.length === 0) return undefined;
  return owners;
}
