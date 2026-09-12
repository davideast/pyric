import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import type { ComponentOwnerInput, SelectableElement } from 'pyric/sandbox/internal';

/**
 * Captures the framework component that owns a listener, so a component
 * using `@pyric/ui`'s data hooks is attributed with no extra code at the
 * call site.
 *
 * This module imports pyric for types only. Nothing here reaches pyric at
 * runtime, and capture itself is gated on `process.env.NODE_ENV`, which a
 * bundler folds to a constant: in a production build the gate is
 * statically false, the capture body is dead code, and an application that
 * uses these hooks ships neither the capture nor pyric. The owner is handed
 * to whatever Firestore implementation the app is wired to; under `pyric
 * sandbox` that is pyric, which derives the element selector and records the
 * owner, and in production the real Firebase SDK ignores the option.
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
 *   it.
 * - `path`, the chain of enclosing component frames, comes from React's own
 *   `captureOwnerStack` export (React 19+; an older peer React leaves `path`
 *   absent). That export exists precisely because the plain call stack does
 *   not carry a parent chain: React's reconciler does not call a parent
 *   component's function from within its child's, so `new Error().stack`
 *   alone can only ever name the immediate function. `captureOwnerStack`
 *   reads React's own render-phase bookkeeping through a public export,
 *   this hook never touches a fiber. Best effort: absent when the installed
 *   React does not report an owner stack for this render, and read
 *   defensively so a React without it is not an error.
 *
 * `ref` is a callback ref the caller may attach to the component's root
 * element. Once attached, the element itself travels on `owner.element`.
 * Turning it into a selector is the sandbox's job, not this module's, so the
 * selector rules stay in one place and this file keeps no runtime import.
 */
/**
 * The owner value this hook produces: a `component` owner carrying the live
 * root element rather than a selector for it. Pyric's attribution derives
 * the selector when the listener attaches; the Firebase SDKs ignore the
 * option entirely.
 */
export type ListenerOwner = ComponentOwnerInput;

export interface UseListenerOwnerResult {
  /** The component owner, or `undefined` in a production build or when this
   *  hook could not identify a calling component frame. */
  owner: ComponentOwnerInput | undefined;
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
 *
 * Computed on first use rather than at module load, so that a production
 * build, where nothing ever asks for it, drops this and everything it calls.
 */
let ownDirectoryCache: string | undefined;

function ownDirectory(): string {
  if (ownDirectoryCache === undefined) ownDirectoryCache = readOwnDirectory();
  return ownDirectoryCache;
}

function readOwnDirectory(): string {
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
  const own = ownDirectory();
  if (own.length > 0 && normalized.startsWith(own)) return true;
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
/**
 * The component that called the hook, read from a render-phase stack.
 *
 * The stack below this hook is fixed in shape: this module's frames, then
 * `useListenerOwner` itself, then any custom hooks the component routed
 * through, then the component, then React. So the first named frame after
 * `useListenerOwner` that is not itself a hook is the component, whatever
 * file it lives in. That is what keeps the answer right in a bundled app,
 * where every module shares one file and a file-based test would exclude the
 * component along with this module. When the hook's own frame is absent, the
 * file-based test is the fallback.
 */
export function componentNameFromStack(stack: string | undefined): string | undefined {
  if (typeof stack !== 'string') return undefined;
  const frames: RenderFrame[] = [];
  for (const line of stack.split('\n')) {
    const frame = parseRenderFrame(line);
    if (frame !== undefined) frames.push(frame);
  }
  const hookIndex = frames.findIndex((frame) => frame.name === 'useListenerOwner');
  if (hookIndex >= 0) {
    for (const frame of frames.slice(hookIndex + 1)) {
      if (isHookName(frame.name)) continue;
      if (frame.file.includes('/node_modules/')) continue;
      return frame.name;
    }
    return undefined;
  }
  for (const frame of frames) {
    if (isFrameworkFile(frame.file)) continue;
    return frame.name;
  }
  return undefined;
}

/** `true` for a frame name that follows React's hook convention (`useX`). */
function isHookName(name: string): boolean {
  const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return /^use[A-Z0-9_]/.test(bare);
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
    if (frame.file.includes('/node_modules/')) continue;
    names.push(frame.name);
  }
  return names.reverse();
}

function captureComponentOwner(
  override: (() => string | null) | undefined,
): ComponentOwnerInput | undefined {
  // The production gate, written inline as a bare `process.env.NODE_ENV`
  // comparison because that is the form every bundler folds to a literal.
  // Folded to `true`, everything below it is dead code and the capture, the
  // stack reading, and this module's pyric types all leave the build. A
  // bundler defines `process.env.NODE_ENV`; under Node it is the real value.
  if (process.env.NODE_ENV === 'production') return undefined;
  const name = componentNameFromStack(new Error().stack);
  if (name === undefined) return undefined;
  const capture = override ?? reactCaptureOwnerStack;
  const path = ancestorPathFromOwnerStack(capture() ?? undefined);
  const owner: ComponentOwnerInput = { kind: 'component', name };
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
  const [base] = useState<ComponentOwnerInput | undefined>(() =>
    captureComponentOwner(options.captureOwnerStack),
  );
  const [element, setElement] = useState<SelectableElement | undefined>(undefined);

  const ref = useCallback((node: SelectableElement | null) => {
    if (node === null) return;
    setElement(node);
  }, []);

  const owner = useMemo<ComponentOwnerInput | undefined>(() => {
    if (base === undefined) return undefined;
    if (element === undefined) return base;
    return { ...base, element };
  }, [base, element]);

  return { owner, ref };
}
