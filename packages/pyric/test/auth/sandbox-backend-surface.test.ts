/**
 * Frozen export-surface characterization for `auth/sandbox-backend`.
 *
 * The sandbox auth engine (`SandboxBackend`) is consumed through a
 * tight seam — `auth/index.ts` and `auth/target.ts` — via
 * `target.backend.<method>(…)` and the module's three runtime
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
import { makeAuthError as originalMakeAuthError } from '../../src/auth/auth-errors.js';
import { NO_PASSWORD_SENTINEL as originalNoPasswordSentinel } from '../../src/auth/sandbox-backend-types.js';

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
  'changeEmail',
  'clearUsers',
  'consumeActionCode',
  'consumeMockResult',
  'createEmailPasswordUser',
  'createSignInCredential',
  'createUser',
  'deleteFor',
  'deleteUser',
  'deliverMail',
  'deliverOne',
  'emitAuthEvent',
  'establishDetachedSession',
  'exportProviderConfig',
  'exportUsers',
  'fanOut',
  'findByEmail',
  'findByUid',
  'getCurrentUser',
  'getIdTokenFor',
  'getIdTokenResultFor',
  'getPersistenceMode',
  'getResolver',
  'isProviderEnabled',
  'linkProvider',
  'listIdentities',
  'listMail',
  'listProviderConfig',
  'listUsers',
  'liveClaims',
  'makeStored',
  'makeUser',
  'mintActionCode',
  'mintAnonymousUser',
  'mintDetachedSession',
  'mintToken',
  'notifyAuthListeners',
  'notifyProviderConfigChanged',
  'notifySessionChanged',
  'notifyUsersChanged',
  'peekActionCode',
  'recordProviderSignIn',
  'reloadFor',
  'requireByEmail',
  'restoreProviderConfig',
  'restoreSession',
  'runBeforeStateChange',
  'sanitizeLinkedProviders',
  'seedUsers',
  'selfTarget',
  'setCurrentUser',
  'setEmailVerified',
  'setMailResolver',
  'setMockResult',
  'setPasswordByEmail',
  'setPersistenceMode',
  'setProviderConfig',
  'setProviderEnforcementDelegated',
  'setRedirectResult',
  'setResolver',
  'stageActionCode',
  'subscribe',
  'subscribeProviderConfig',
  'subscribeSession',
  'subscribeUsers',
  'takeMail',
  'takeRedirectResult',
  'toRecord',
  'transitionCurrentUser',
  'unlinkProvider',
  'updateEmailFor',
  'updatePasswordFor',
  'updateProfileByUid',
  'updateProfileFor',
  'updateUser',
  'upsertEmailLinkUser',
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

  // A re-export can be re-pointed at a look-alike (a local shim, a
  // differently-configured factory) without changing its name or
  // typeof — the two checks above wouldn't notice. Assert value
  // identity against the origin modules so a future re-export fork
  // (barrel re-exports a DIFFERENT `makeAuthError` /
  // `NO_PASSWORD_SENTINEL` than the one the rest of the codebase
  // imports) breaks this test instead of silently diverging.
  it('re-exports are the SAME binding as their origin modules, not a fork', () => {
    expect(backendModule.makeAuthError).toBe(originalMakeAuthError);
    expect(backendModule.NO_PASSWORD_SENTINEL).toBe(originalNoPasswordSentinel);
  });
});
