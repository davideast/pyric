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

import type { ListenerOwner, OwnerStackFrame } from '../types/events.js';
import { listenerAttributionEnabled } from './attribution-mode.js';
import { captureAttachStack, ownerFramesPolicy } from './owner-frames.js';
import {
  isSelectableElement,
  ownerSelectorFor,
  tagNameOf,
  type SelectableElement,
} from './element-selector.js';

/**
 * The input form of a `component` owner, as a framework binding builds it.
 *
 * It differs from the recorded {@link ListenerOwner} `component` form in one
 * field: `element` is the live DOM element, not a selector for it. The
 * binding hands the element over and this module derives the selector,
 * exactly as it does for an element hint, so that the selector rules live in
 * one place and the binding never has to import pyric at runtime. Owners are
 * serialized into events, so the element itself is never kept on the
 * recorded owner.
 */
export interface ComponentOwnerInput {
  kind: 'component';
  /** The component function's name, read from the render-phase stack. */
  name: string;
  /** The chain of enclosing component frames, outermost first. */
  path?: string[];
  /** The component's root element, when the binding's ref was attached. */
  element?: SelectableElement;
}

/**
 * What a caller may pass as a listener's `owner`: a name, the DOM element the
 * listener feeds, a fully-built {@link ListenerOwner} record, or a
 * {@link ComponentOwnerInput}. The last two forms are for a framework binding
 * (`@pyric/ui`'s `useListenerOwner`) that has already identified the owning
 * component and wants it recorded as a `component` owner rather than wrapped
 * in a `tag`.
 */
export type ListenerOwnerHint =
  | string
  | SelectableElement
  | ListenerOwner
  | ComponentOwnerInput;

/** `true` when `value` is already an owner record rather than a name or an
 *  element to derive one from. */
function isOwnerRecord(
  value: ListenerOwnerHint,
): value is ListenerOwner | ComponentOwnerInput {
  if (value === null || typeof value !== 'object') return false;
  return 'kind' in value && typeof (value as { kind: unknown }).kind === 'string';
}

/**
 * Turn an owner record into its recorded form. A `component` owner carrying a
 * live element has that element replaced by a selector; a `component` owner
 * whose `element` is not a selectable element drops the field. Every other
 * owner kind is already in recorded form and passes through unchanged.
 */
function recordedOwner(value: ListenerOwner | ComponentOwnerInput): ListenerOwner {
  if (value.kind !== 'component') return value as ListenerOwner;
  const owner: Extract<ListenerOwner, { kind: 'component' }> = {
    kind: 'component',
    name: value.name,
  };
  if (value.path !== undefined && value.path.length > 0) owner.path = value.path;
  const element = value.element;
  if (typeof element === 'string') {
    owner.element = element;
  } else if (element !== undefined && isSelectableElement(element)) {
    owner.element = ownerSelectorFor(element);
    owner.tag = tagNameOf(element);
  }
  return owner;
}

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

/** A frame inside pyric itself, an installed dependency, or the runtime. */
function isInternalFrame(file: string): boolean {
  if (file.includes('/node_modules/')) return true;
  // JavaScriptCore names a built-in's frame `native`; Node's own modules are `node:`.
  if (file === 'native' || file.startsWith('node:')) return true;
  if (PYRIC_ROOT.length > 0 && file.startsWith(`${PYRIC_ROOT}/`)) return true;
  // Source and built SDK copies share the page journal. Its registration frame
  // can therefore come from the sibling tree during workspace development.
  const sibling = PYRIC_ROOT.endsWith('/src') ? `${PYRIC_ROOT.slice(0, -4)}/dist`
    : PYRIC_ROOT.endsWith('/dist') ? `${PYRIC_ROOT.slice(0, -5)}/src` : '';
  if (sibling && file.startsWith(`${sibling}/`)) return true;
  return false;
}

const FRAME_WITH_FUNCTION = /^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/;
const FRAME_WITHOUT_FUNCTION = /^\s*at\s+(.+):(\d+):(\d+)\s*$/;
/** SpiderMonkey and JavaScriptCore: `fn@url:12:5`, or `@url:12:5` unnamed. */
const FRAME_AT_SIGN = /^\s*(.*?)@(.+):(\d+):(\d+)\s*$/;

/**
 * Parse one stack line into a `frame` owner. The V8 formats
 * `at fn (/path/file.ts:12:5)` and `at /path/file.ts:12:5` are handled, and
 * so is the `fn@url:12:5` form Firefox and Safari write. Anything else (a
 * header line, a `native` frame) returns `undefined` and is skipped.
 */
export function parseStackFrame(line: string): ListenerOwner | undefined {
  const named = FRAME_WITH_FUNCTION.exec(line);
  if (named) return frameOwner(named[2]!, named[3]!, named[4]!, named[1]!);
  const bare = FRAME_WITHOUT_FUNCTION.exec(line);
  if (bare) return frameOwner(bare[1]!, bare[2]!, bare[3]!, '');
  const atSign = FRAME_AT_SIGN.exec(line);
  if (atSign) return frameOwner(atSign[2]!, atSign[3]!, atSign[4]!, atSign[1]!);
  return undefined;
}

function frameOwner(file: string, line: string, column: string, name: string): ListenerOwner {
  const owner: Extract<ListenerOwner, { kind: 'frame' }> = {
    kind: 'frame',
    file: stripFileScheme(file),
    line: Number(line),
    column: Number(column),
  };
  if (name.length > 0) owner.function = name;
  return owner;
}

/**
 * The application frame that opened a listener, read from `stack`, with the
 * application frames around it as its `stack` when the policy keeps more than
 * one (see `owner-frames.ts`). Frames inside pyric or an installed dependency
 * are never application frames. The owner shows the first frame outside the
 * policy's skipped modules, or the first application frame when every one is
 * skipped. Exported for the test, which supplies a synthetic stack.
 */
export function callerFrameFromStack(stack: string): ListenerOwner | undefined {
  const { frames, skips } = ownerFramesPolicy();
  const kept: OwnerStackFrame[] = [];
  let shown: number | undefined;
  for (const line of stack.split('\n')) {
    const frame = parseStackFrame(line);
    if (frame?.kind !== 'frame') continue;
    if (isInternalFrame(frame.file)) continue;
    const { kind: _kind, ...position } = frame;
    if (shown === undefined && !skips(frame.file)) shown = kept.length;
    kept.push(position);
    const isFull = shown !== undefined && kept.length - shown >= frames;
    if (isFull) break;
  }
  if (kept.length === 0) return undefined;
  const chain = shown === undefined ? kept.slice(0, frames) : kept;
  const owner: ListenerOwner = { kind: 'frame', ...chain[shown ?? 0]! };
  if (chain.length > 1) owner.stack = chain;
  return owner;
}

/**
 * Capture the frame that created a listener. `undefined` when attribution is
 * off, when the runtime produced no stack, or when every frame on it belongs
 * to pyric.
 */
export function captureCreationFrame(): ListenerOwner | undefined {
  if (!listenerAttributionEnabled()) return undefined;
  const stack = captureAttachStack();
  if (stack === undefined) return undefined;
  return callerFrameFromStack(stack);
}

/**
 * Build the explicit owner from whatever the caller passed as `owner`. A
 * string is the name of a `tag` owner verbatim; an element contributes its
 * tag name plus a selector that finds it again; an owner record (a framework
 * binding's `component` owner) is recorded as it stands, except that a live
 * element on a `component` owner is reduced to a selector here. Unlike frame
 * capture this is not gated on the attribution switch: the caller asked for
 * it by name.
 */
export function tagOwnerFor(hint: ListenerOwnerHint | undefined): ListenerOwner | undefined {
  if (hint === undefined) return undefined;
  if (typeof hint === 'string') {
    if (hint.length === 0) return undefined;
    return { kind: 'tag', name: hint };
  }
  if (isOwnerRecord(hint)) return recordedOwner(hint);
  if (!isSelectableElement(hint)) return undefined;
  return { kind: 'tag', name: tagNameOf(hint), element: ownerSelectorFor(hint) };
}

/**
 * The internal listen option that carries owners a caller already recorded.
 *
 * It exists for one caller: a client that reaches the sandbox across a port
 * rather than calling it in the same context. The served page runs the
 * sandbox in a SharedWorker, so an attach inside the worker sees a
 * worker-bundle frame, no `owner` hint, and no DOM. That client derives the
 * owners on the page, where all three are real, and hands them over here.
 *
 * The option is reached through `pyric/sandbox/internal` and is not part of
 * any mirrored Firebase surface. The public `owner` hint is unchanged: a
 * caller still passes a name, an element, or a component record, and the
 * sandbox still derives the owners itself when no `owners` arrive.
 */
export interface RecordedListenerOwners {
  readonly owners?: readonly ListenerOwner[];
}

/**
 * Both attribution inputs a listen call can carry: the caller's `owner` hint
 * and, for a caller on the other side of a port, the owners it already
 * recorded. Backends that take attribution as one argument take this.
 */
export interface ListenerAttribution extends RecordedListenerOwners {
  readonly owner?: ListenerOwnerHint;
}

/**
 * Every owner known at attach time, in a stable order: frame first, then tag.
 * Returns `undefined` rather than an empty array so an event with no
 * attribution omits the field entirely.
 *
 * `recorded` owners replace both: the caller derived them where the calling
 * frame and the DOM exist, so deriving them again here would only describe
 * this context.
 */
export function listenerAttachOwners(
  hint?: ListenerOwnerHint,
  recorded?: readonly ListenerOwner[],
): ListenerOwner[] | undefined {
  if (recorded !== undefined && recorded.length > 0) return [...recorded];
  const owners: ListenerOwner[] = [];
  const frame = captureCreationFrame();
  if (frame !== undefined) owners.push(frame);
  const tag = tagOwnerFor(hint);
  if (tag !== undefined) owners.push(tag);
  if (owners.length === 0) return undefined;
  return owners;
}
