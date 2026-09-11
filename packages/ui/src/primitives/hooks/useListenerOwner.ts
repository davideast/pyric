import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import type { ListenerOwner } from 'pyric/sandbox';
import {
  isSelectableElement,
  listenerAttributionEnabled,
  ownerSelectorFor,
  type SelectableElement,
} from 'pyric/sandbox/internal';

/**
 * Captures the framework component that owns a listener, so a component
 * using `@pyric/ui`'s data hooks is attributed with no extra code at the
 * call site.
 *
 * Capture happens during render, while the calling component function is
 * still on the call stack, the same moment `pyric/sandbox`'s own `frame`
 * attribution reads a stack. Two things are read from two different stacks:
 *
 * - `name` comes from `new Error().stack`, the plain call stack. The first
 *   frame outside this module's own directory and `node_modules` (which
 *   covers `react`, `react-dom`, and every other dependency, `pyric`
 *   included) is the component function currently rendering; this hook is
 *   always called directly from that function's body, so that frame names
 *   it. A minified production build mangles this the same way it mangles any
 *   other identifier; state that to the consumer rather than guessing at the
 *   original name.
 * - `path`, the chain of enclosing component frames, comes from React's own
 *   `captureOwnerStack` export (React 19+; an older peer React leaves `path`
 *   absent). That export exists precisely because the plain call stack does
 *   not carry a parent chain: React's reconciler does not call a parent
 *   component's function from within its child's, so `new Error().stack`
 *   alone can only ever name the immediate function. `captureOwnerStack`
 *   reads React's own render-phase bookkeeping through a public export,
 *   this hook never touches a fiber. Best effort: absent when the installed
 *   React does not report an owner stack for this render.
 *
 * `ref` is a callback ref the caller may attach to the component's root
 * element. Once attached, `owner.element` is filled in with the same
 * selector `pyric/sandbox`'s attribution module uses for a caller-supplied
 * tag element, imported from `pyric/sandbox/internal` rather than
 * duplicated.
 *
 * Capture is skipped entirely, and `owner` is `undefined`, when listener
 * attribution is off, the same production/test switch `pyric/sandbox`
 * itself reads.
 */
export interface UseListenerOwnerResult {
  /** The component owner, or `undefined` when attribution is off or this
   *  hook could not identify a calling component frame. */
  owner: ListenerOwner | undefined;
  /** Attach to the component's root element to fill in `owner.element`. */
  ref: (element: SelectableElement | null) => void;
}

export interface UseListenerOwnerOptions {
  /**
   * Test seam: a stand-in for React's `captureOwnerStack` export. Some test
   * renderers do not populate an owner stack the way a real browser render
   * does, so tests inject a fixture string here to exercise the parsing
   * logic. Production callers omit this; the hook reads `react`'s own
   * export when it exists.
   */
  captureOwnerStack?: () => string | null;
}

const FRAME_WITH_FUNCTION = /^\s*at\s+([^\s(]+)\s+\((.+):(\d+):(\d+)\)\s*$/;

/**
 * `@pyric/ui`'s own package root (the `src` directory under source, `dist`
 * under a build), derived from `import.meta.url` rather than a hardcoded
 * `packages/ui` string. A hardcoded string would misfire inside this very
 * monorepo, where the test files that exercise a consumer component also
 * happen to sit under a path containing `packages/ui` (`packages/ui/test/
 * ...`), only this package's own source or build output should be
 * excluded, not sibling test or app code that shares the package root by
 * coincidence of this repository's own layout.
 *
 * This file sits at `<root>/primitives/hooks/useListenerOwner.{ts,js}`, so
 * the root is two path segments up.
 */
const OWN_DIRECTORY = ownDirectory();

function ownDirectory(): string {
  const here = importMetaUrl();
  if (here === undefined) return '';
  const withoutFile = here.slice(0, here.lastIndexOf('/'));
  const withoutHooks = withoutFile.slice(0, withoutFile.lastIndexOf('/'));
  const withoutPrimitives = withoutHooks.slice(0, withoutHooks.lastIndexOf('/'));
  return `${withoutPrimitives}/`;
}

/** This module's own URL, or `undefined` inside a bundle that erased it. */
function importMetaUrl(): string | undefined {
  try {
    const url = (import.meta as { url?: unknown }).url;
    if (typeof url !== 'string') return undefined;
    return stripFileScheme(url);
  } catch {
    return undefined;
  }
}

function stripFileScheme(url: string): string {
  if (url.startsWith('file://')) return url.slice('file://'.length);
  return url;
}

function isFrameworkFile(file: string): boolean {
  const normalized = stripFileScheme(file);
  if (normalized.includes('/node_modules/')) return true;
  if (OWN_DIRECTORY.length > 0 && normalized.startsWith(OWN_DIRECTORY)) return true;
  return false;
}

interface RenderFrame {
  name: string;
  file: string;
}

function parseRenderFrame(line: string): RenderFrame | undefined {
  const match = FRAME_WITH_FUNCTION.exec(line);
  if (!match) return undefined;
  return { name: match[1]!, file: match[2]! };
}

/** The first non-framework frame in a plain call stack: the component
 *  currently rendering, when this is called directly from its body. */
function callingComponentName(stack: string | undefined): string | undefined {
  if (typeof stack !== 'string') return undefined;
  for (const line of stack.split('\n')) {
    const frame = parseRenderFrame(line);
    if (frame === undefined) continue;
    if (isFrameworkFile(frame.file)) continue;
    return frame.name;
  }
  return undefined;
}

/** `react`'s own `captureOwnerStack` export, when the installed version has
 *  one. Older peer React versions (this package's peer range starts at 18)
 *  don't export it, so the read is guarded rather than a static import. */
function reactCaptureOwnerStack(): string | undefined {
  const capture = (React as { captureOwnerStack?: () => string | null }).captureOwnerStack;
  if (typeof capture !== 'function') return undefined;
  return capture() ?? undefined;
}

/** The enclosing component names an owner stack reports, outermost first.
 *  Best effort: a frame an owner stack doesn't carry a location for is
 *  simply skipped rather than breaking the chain. */
function ancestorPathFromOwnerStack(stack: string | undefined): string[] {
  if (typeof stack !== 'string' || stack.length === 0) return [];
  const names: string[] = [];
  for (const line of stack.split('\n')) {
    const frame = parseRenderFrame(line);
    if (frame === undefined) continue;
    if (isFrameworkFile(frame.file)) continue;
    names.push(frame.name);
  }
  return names.reverse();
}

type ComponentOwner = Extract<ListenerOwner, { kind: 'component' }>;

function captureComponentOwner(
  captureOwnerStack: () => string | null | undefined,
): ComponentOwner | undefined {
  if (!listenerAttributionEnabled()) return undefined;
  const name = callingComponentName(new Error().stack);
  if (name === undefined) return undefined;
  const path = ancestorPathFromOwnerStack(captureOwnerStack() ?? undefined);
  const owner: ComponentOwner = { kind: 'component', name };
  if (path.length > 0) owner.path = path;
  return owner;
}

/**
 * Run during render, from the component that will go on to attach a
 * listener. Returns `{ owner, ref }`: pass `owner` as the listener's `owner`
 * option, and optionally attach `ref` to the component's root element.
 */
export function useListenerOwner(
  options: UseListenerOwnerOptions = {},
): UseListenerOwnerResult {
  const capture = options.captureOwnerStack ?? reactCaptureOwnerStack;
  const [base] = useState<ComponentOwner | undefined>(() => captureComponentOwner(capture));
  const [element, setElement] = useState<string | undefined>(undefined);

  const ref = useCallback((node: SelectableElement | null) => {
    if (node === null) return;
    if (!isSelectableElement(node)) return;
    setElement(ownerSelectorFor(node));
  }, []);

  const owner = useMemo<ComponentOwner | undefined>(() => {
    if (base === undefined) return undefined;
    if (element === undefined) return base;
    return { ...base, element };
  }, [base, element]);

  return { owner, ref };
}
