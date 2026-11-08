/**
 * Public interface types for `pyric-admin/app-check`.
 */
import type { AppCheckTokenClaims } from 'pyric/sandbox/internal';

export interface AppCheckTokenOptions {
  ttlMillis?: number;
  limitedUse?: boolean;
  jti?: string;
}

export interface AppCheckToken {
  token: string;
  ttlMillis: number;
}

export interface VerifyAppCheckTokenOptions {
  consume?: boolean;
}

export interface DecodedAppCheckToken extends AppCheckTokenClaims {
  app_id: string;
}

export interface VerifyAppCheckTokenResponse {
  appId: string;
  token: DecodedAppCheckToken;
  alreadyConsumed?: boolean;
}
