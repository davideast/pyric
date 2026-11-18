/**
 * `pyric-admin/auth` public re-export barrel.
 */
export { getAuth } from './auth-service.js';
export { AuthClientErrorCode, type AuthErrorCodeInfo } from './error-codes.js';
export {
  Auth,
  BaseAuth,
  UserInfo,
  UserMetadata,
  UserRecord,
  type CreateRequest,
  type DecodedIdToken,
  type ListUsersResult,
  type UpdateRequest,
} from './types.js';
export { FirebaseAuthError } from './verify-token.js';
