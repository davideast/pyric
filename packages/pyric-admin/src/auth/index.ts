/**
 * `pyric-admin/auth` public re-export barrel.
 */
export { Auth } from './auth.js';
export { getAuth } from './auth-service.js';
export { BaseAuth } from './base-auth.js';
export {
  AuthErrorCode,
  type AuthErrorCodeInfo,
  type AuthErrorCodeKey,
  type AuthErrorCodeValue,
} from './error-codes.js';
export type {
  CreateRequest,
  DecodedIdToken,
  ListUsersResult,
  UpdateRequest,
} from './types.js';
export { UserInfo } from './user-info.js';
export { UserMetadata } from './user-metadata.js';
export { UserRecord } from './user-record.js';
export { FirebaseAuthError } from './verify-token.js';
