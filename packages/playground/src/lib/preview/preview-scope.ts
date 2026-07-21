/**
 * The contract between the playground (which loads the values) and
 * the user's compiled bundle (which references them via aliased
 * imports). The preview's esbuild config redirects every import the
 * user code might write to a synthetic module that re-exports from
 * `globalThis.__pyricPreview__`. This file is that contract.
 *
 * Firebase subpaths are prefix-mapped to Pyric subpaths. AppPreview
 * installs the corresponding module namespaces; the compiler does not
 * maintain per-export allow-lists.
 */

import * as React from 'react';
import type * as ReactDOM from 'react-dom';
import type * as ReactDOMClient from 'react-dom/client';
import type { Sandbox } from 'pyric/sandbox';

/**
 * Modules the preview plugin knows how to virtualize.
 *
 * React remains explicitly virtualized; Firebase service modules use
 * the open-ended `pyric/*` namespace contract below.
 */
export type PreviewModuleId =
  | 'react'
  | 'react/jsx-runtime'
  | 'react/jsx-dev-runtime'
  | 'react-dom'
  | 'react-dom/client'
  | '@pyric/cli/conformance/browser'
  | `pyric/${string}`
  | './firebase';

/**
 * The full scope: keys are module specifiers as they appear in the
 * user's import statements; values are objects whose own properties
 * become the named exports the user can destructure.
 */
export interface PreviewScope {
  react: typeof React;
  'react/jsx-runtime': Record<string, unknown>;
  'react/jsx-dev-runtime': Record<string, unknown>;
  'react-dom': typeof ReactDOM;
  'react-dom/client': typeof ReactDOMClient;
  '@pyric/cli/conformance/browser': Record<string, unknown>;
  [moduleId: `pyric/${string}`]: Record<string, unknown>;
  /**
   * The user's `./firebase` module — exports `db`. Preview supplies
   * the sandbox-managed handle; a production application supplies a
   * Firebase instance from its own project initialization.
   */
  './firebase': { db: ReturnType<typeof PyricFirestore.getFirestore> };
}

interface InstalledPreviewScope extends PreviewScope {
  /**
   * The runner's sandbox handle, exposed for runner code, NOT for
   * appSource. AppPreview doesn't read this — it's here so other
   * playground tooling can confirm a scope is installed.
   */
  __sandbox: Sandbox;
}

const GLOBAL_KEY = '__pyricPreview__';

/**
 * Install the scope on `globalThis`. Called by AppPreview before
 * each evaluated bundle. Replaces any previous install — there's
 * exactly one preview at a time.
 */
export function installPreviewScope(scope: InstalledPreviewScope): void {
  (globalThis as unknown as Record<string, InstalledPreviewScope>)[GLOBAL_KEY] = scope;
}

/** Read the installed scope from a synthetic module. */
export function readPreviewScope(): InstalledPreviewScope {
  const scope = (globalThis as unknown as Record<string, InstalledPreviewScope>)[GLOBAL_KEY];
  if (!scope) {
    throw new Error(
      '__pyricPreview__ scope not installed; call installPreviewScope() before evaluating user bundle',
    );
  }
  return scope;
}

export { GLOBAL_KEY as PREVIEW_GLOBAL };
