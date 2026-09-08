/** Public modular Auth composition. Implementations live in API-family files. */

export type {
  Auth,
  AppAuth,
  AuthFlowRequest,
  AuthFlowResolver,
  AuthObserver,
  IdTokenResult,
  Persistence,
  Unsubscribe,
  User,
  UserCredential,
  UserInfo,
} from './types.js';
export { TARGET_SYMBOL } from './types.js';
export type { AuthProvider } from './providers.js';
export type {
  AuthUserRecord,
  CreateUserRequest,
  MintSessionRequest,
  MintedSession,
  ProviderUserInfo,
  SeedUser,
  SignInIdentitySpec,
  UpdateUserRequest,
} from './sandbox-backend.js';
export type { AuthMailResolver, OutboundAuthMail } from './sandbox-auth-flow.js';
export type { AvatarMint, AvatarMintInput } from './sandbox/default-avatar.js';

export {
  EmailAuthProvider,
  FacebookAuthProvider,
  GithubAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  SAMLAuthProvider,
  TwitterAuthProvider,
  FEDERATED_PROVIDER_IDS,
  type FederatedProviderId,
} from './providers.js';
export {
  AuthCredential,
  EmailAuthCredential,
  OAuthCredential,
  getAdditionalUserInfo,
  type AdditionalUserInfo,
} from './credentials.js';
export {
  ActionCodeOperation,
  AuthErrorCodes,
  OperationType,
  ProviderId,
  SignInMethod,
} from './enums.js';
export {
  browserCookiePersistence,
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  debugErrorMap,
  indexedDBLocalPersistence,
  inMemoryPersistence,
  prodErrorMap,
  type AuthErrorMap,
} from './config-tokens.js';
export { ActionCodeURL, parseActionCodeURL } from './action-code-url.js';
export {
  applyActionCode,
  checkActionCode,
  confirmPasswordReset,
  sendEmailVerification,
  sendPasswordResetEmail,
  verifyBeforeUpdateEmail,
  verifyPasswordResetCode,
  type ActionCodeInfo,
  type ActionCodeSettings,
} from './action-codes.js';
export {
  isSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithEmailLink,
} from './email-link.js';
export { linkWithCredential, linkWithPopup, linkWithRedirect, unlink } from './linking.js';
export {
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  reauthenticateWithRedirect,
} from './reauth.js';
export { revokeAccessToken, signInWithCustomToken } from './tokens.js';
export { validatePassword, type PasswordPolicy, type PasswordValidationStatus } from './password-policy.js';

export { connectAuthEmulator, getAuth, initializeAuth } from './instances.js';
export {
  createUserWithEmailAndPassword,
  getRedirectResult,
  setPersistence,
  signInAnonymously,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from './sign-in.js';
export {
  beforeAuthStateChanged,
  deleteUser,
  getIdToken,
  getIdTokenResult,
  onAuthStateChanged,
  onIdTokenChanged,
  reload,
  updateCurrentUser,
  updateEmail,
  updatePassword,
  updateProfile,
  useDeviceLanguage,
} from './user-lifecycle.js';
export { sandbox } from './sandbox/driver.js';
import type { AuthLens } from '../sandbox/types/operation.js';
export type { AuthLens };

let _activeAuthLens: AuthLens | undefined;
const _authLensListeners = new Set<(lens: AuthLens | undefined) => void>();

/** Switch the active AuthLens for subsequent data operations. */
export function switchAuthLens(lens: AuthLens | undefined): void {
  _activeAuthLens = lens && lens.mode === 'app-session' ? undefined : lens;
  for (const cb of [..._authLensListeners]) {
    cb(_activeAuthLens);
  }
}

/** Return the currently active AuthLens, or undefined if using the default app session. */
export function getAuthLens(): AuthLens | undefined {
  return _activeAuthLens;
}

/** Subscribe to AuthLens changes. Returns an unsubscribe function. */
export function onAuthLensChanged(cb: (lens: AuthLens | undefined) => void): () => void {
  _authLensListeners.add(cb);
  return () => {
    _authLensListeners.delete(cb);
  };
}
