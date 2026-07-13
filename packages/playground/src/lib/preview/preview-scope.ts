/**
 * The contract between the playground (which loads the values) and
 * the user's compiled bundle (which references them via aliased
 * imports). The preview's esbuild config redirects every import the
 * user code might write to a synthetic module that re-exports from
 * `globalThis.__pyricPreview__`. This file is that contract.
 *
 * Adding a new identifier the agent might import requires three
 * coordinated edits:
 *   1. Add it here under the right module bucket.
 *   2. Add an entry to the alias map in `virtual-imports-plugin.ts`.
 *   3. Set the value when `installPreviewScope` is called from
 *      `AppPreview`.
 *
 * Deliberately mirrors the `firebase/firestore` modular surface plus
 * the small slice of React the agent's TSX needs. The `pyric/firestore`
 * `sandbox.*` namespace is absent on purpose — runner code (a separate
 * artifact, not `appSource`) is where firestore sandbox primitives
 * belong. The `pyric/auth` `sandbox` namespace IS exposed under
 * `firebase/auth` for preview tests that need `seedUsers` /
 * `setUser` / `mockSignInResult` — preview-only; see the safety note
 * on the `firebase/auth` slot below.
 */

import * as React from 'react';
import type * as PyricAuth from 'pyric/auth';
import type * as PyricFirestore from 'pyric/firestore';
import type * as PyricRtdbModular from 'pyric/database';
import type { Sandbox } from 'pyric/sandbox';

/**
 * Modules the preview plugin knows how to virtualize.
 *
 * Deliberately minimal — `appSource` is just the `App` component.
 * `firebase/app` (`initializeApp` + `getApp`) lives in the
 * template's `main.tsx`, called once before `App` mounts;
 * `react-dom` / `react-dom/client` belong to `IframePreview`'s
 * `createRoot`, not user code. Exposing them here would let
 * `appSource` accidentally reach for APIs the template handles
 * — and those calls would have no analog in the sandbox.
 */
export type PreviewModuleId =
  | 'react'
  | 'react/jsx-runtime'
  | 'react/jsx-dev-runtime'
  | 'firebase/firestore'
  | 'firebase/auth'
  | 'firebase/database'
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
  'firebase/firestore': Pick<
    typeof PyricFirestore,
    | 'getFirestore'
    | 'onSnapshot'
    | 'collection'
    | 'collectionGroup'
    | 'doc'
    | 'getDoc'
    | 'getDocs'
    | 'setDoc'
    | 'addDoc'
    | 'updateDoc'
    | 'deleteDoc'
    | 'query'
    | 'where'
    | 'or'
    | 'and'
    | 'orderBy'
    | 'limit'
    | 'limitToLast'
    | 'startAt'
    | 'startAfter'
    | 'endAt'
    | 'endBefore'
    | 'runTransaction'
    | 'writeBatch'
    | 'serverTimestamp'
    | 'increment'
    | 'arrayUnion'
    | 'arrayRemove'
    | 'deleteField'
    | 'FieldValue'
    | 'Timestamp'
    | 'refEqual'
    | 'queryEqual'
    | 'snapshotEqual'
  >;
  /**
   * The `firebase/auth` modular surface — aliased to `pyric/auth` at
   * preview-bundle time. AppPreview supplies the mirror functions so
   * `getAuth(sandbox)` and the sign-in family work against the
   * runner's sandbox. Outside the Playground, normal production
   * resolution supplies the upstream `firebase/auth` surface.
   *
   * The `sandbox` slot is a preview-only escape hatch — it gives
   * preview tests access to `seedUsers` / `setUser` /
   * `mockSignInResult` so probes can pre-stage test users with
   * customClaims before driving rules-engine assertions. It is a host
   * testing capability, not an API that generated application source
   * may import or call.
   */
  'firebase/auth': Pick<
    typeof PyricAuth,
    | 'getAuth'
    | 'connectAuthEmulator'
    | 'onAuthStateChanged'
    | 'onIdTokenChanged'
    | 'signInAnonymously'
    | 'signInWithEmailAndPassword'
    | 'createUserWithEmailAndPassword'
    | 'signOut'
    | 'setPersistence'
    | 'signInWithPopup'
    | 'signInWithCredential'
    | 'signInWithRedirect'
    | 'getRedirectResult'
    | 'getIdToken'
    | 'getIdTokenResult'
    | 'GoogleAuthProvider'
    | 'EmailAuthProvider'
    | 'FacebookAuthProvider'
    | 'GithubAuthProvider'
    | 'OAuthProvider'
    | 'browserLocalPersistence'
    | 'browserSessionPersistence'
    | 'inMemoryPersistence'
    | 'sandbox'
  >;
  /**
   * The `firebase/database` modular surface — aliased to `pyric/database`
   * at preview-bundle time. AppPreview supplies the mirror functions so
   * `getDatabase(sandbox)` and the read/write
   * family operate against the runner's sandbox. Outside the
   * Playground, normal production resolution supplies the upstream
   * `firebase/database` surface, so app code stays portable.
   *
   * Wrap rationale (mirrors `firebase/firestore`'s `getFirestore`):
   * a bare `getDatabase()` call with no args defaults to the runner's
   * sandbox in the preview. Normal production resolution loads
   * `firebase/database` directly.
   *
   * The `sandbox.*` test-driver namespace is deliberately omitted —
   * `setRules` / `setData` / `snapshotState` are runner-side affordances,
   * not app code.
   */
  'firebase/database': Pick<
    typeof PyricRtdbModular,
    | 'getDatabase'
    | 'ref'
    | 'child'
    | 'get'
    | 'set'
    | 'update'
    | 'remove'
    | 'push'
    | 'onValue'
    | 'off'
    | 'serverTimestamp'
    | 'connectDatabaseEmulator'
  >;
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
