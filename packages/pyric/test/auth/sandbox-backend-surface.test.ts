/**
 * Frozen export-surface characterization for `auth/sandbox-backend`.
 *
 * The sandbox auth engine (`SandboxBackend`) is consumed through a
 * tight seam — `auth/index.ts`, `auth/target.ts`, `auth/prod-backend.ts`
 * — via `target.backend.<method>(…)` and the module's three runtime
 * exports. This test freezes BOTH surfaces so a mechanical refactor
 * (splitting the God-file into concept modules behind the
 * `sandbox-backend.js` barrel) cannot silently drop, rename, or add a
 * method or export. TypeScript `private` is erased at runtime, so the
 * whole prototype is captured — every method the split must preserve,
 * public or internal.
 *
 * If this list changes intentionally, update the frozen arrays in the
 * SAME commit that changes the surface, and say why in the message.
 */
import { describe, expect, it } from 'bun:test';
import * as backendModule from '../../src/auth/sandbox-backend.js';
import { SandboxBackend } from '../../src/auth/sandbox-backend.js';

/** Every runtime (value) export of the barrel. Type-only exports are
 *  erased at runtime and are guarded by `tsc` on the consumers instead. */
const FROZEN_MODULE_EXPORTS = ['NO_PASSWORD_SENTINEL', 'SandboxBackend', 'makeAuthError'];

/** Every method on `SandboxBackend.prototype` (constructor excluded).
 *  Includes TS-`private` methods — erased at runtime, so a rename or a
 *  dropped delegation still trips this. */
const FROZEN_PROTOTYPE_METHODS = [
  'applyEmailToUser',
  'applyProfileToUser',
  'applyStoredToUser',
  'assertProviderEnabled',
  'assertSignInAllowed',
  'beforeAuthStateChanged',
  'buildUserFromState',
  'buildUserFromStored',
  'clearUsers',
  'consumeMockResult',
  'createEmailPasswordUser',
  'createSignInCredential',
  'createUser',
  'deleteFor',
  'deleteUser',
  'deliverOne',
  'emitAuthEvent',
  'establishDetachedSession',
  'exportProviderConfig',
  'exportUsers',
  'fanOut',
  'findByEmail',
  'getCurrentUser',
  'getIdTokenFor',
  'getIdTokenResultFor',
  'getPersistenceMode',
  'getResolver',
  'isProviderEnabled',
  'listIdentities',
  'listProviderConfig',
  'listUsers',
  'liveClaims',
  'makeStored',
  'makeUser',
  'mintAnonymousUser',
  'mintDetachedSession',
  'mintToken',
  'notifyAuthListeners',
  'notifyProviderConfigChanged',
  'notifySessionChanged',
  'notifyUsersChanged',
  'recordProviderSignIn',
  'reloadFor',
  'restoreProviderConfig',
  'restoreSession',
  'runBeforeStateChange',
  'sanitizeLinkedProviders',
  'seedUsers',
  'setCurrentUser',
  'setMockResult',
  'setPersistenceMode',
  'setProviderConfig',
  'setProviderEnforcementDelegated',
  'setRedirectResult',
  'setResolver',
  'subscribe',
  'subscribeProviderConfig',
  'subscribeSession',
  'subscribeUsers',
  'takeRedirectResult',
  'toRecord',
  'transitionCurrentUser',
  'updateEmailFor',
  'updatePasswordFor',
  'updateProfileByUid',
  'updateProfileFor',
  'updateUser',
  'validatePassword',
];

describe('sandbox-backend export surface (frozen)', () => {
  it('exposes exactly the frozen runtime exports', () => {
    const actual = Object.keys(backendModule).sort();
    expect(actual).toEqual(FROZEN_MODULE_EXPORTS);
  });

  it('keeps the runtime export kinds stable', () => {
    expect(typeof (backendModule as Record<string, unknown>).SandboxBackend).toBe('function');
    expect(typeof (backendModule as Record<string, unknown>).makeAuthError).toBe('function');
    expect(typeof (backendModule as Record<string, unknown>).NO_PASSWORD_SENTINEL).toBe('string');
  });

  it('exposes exactly the frozen SandboxBackend prototype methods', () => {
    const actual = Object.getOwnPropertyNames(SandboxBackend.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(actual).toEqual(FROZEN_PROTOTYPE_METHODS);
  });
});
