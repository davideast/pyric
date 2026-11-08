/**
 * `pyric-admin/auth` public re-export barrel.
 */
export { getAuth } from './auth-service.js';
export type {
  Auth,
  CreateRequest,
  DecodedIdToken,
  ListUsersResult,
  UpdateRequest,
  UserInfo,
  UserMetadata,
  UserRecord,
} from './types.js';
