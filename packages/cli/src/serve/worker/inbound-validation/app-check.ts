import { MAX_CONSUMED_TOKEN_ID_LENGTH } from 'pyric/sandbox/internal';
import {
  requireOptionalBoolean,
  requireOptionalString,
  requireShape,
  requireString,
} from './fields.js';

export type AppCheckMethod =
  | 'appCheck.getToken'
  | 'appCheck.getLimitedUseToken'
  | 'appCheck.consumeToken';

/** Validates inbound `appCheck.*` worker operation arguments. */
export function assertAppCheckArguments(
  method: AppCheckMethod,
  message: Record<string, unknown>,
): void {
  switch (method) {
    case 'appCheck.getToken':
      requireOptionalString(message.appId, 'appId');
      requireOptionalString(message.projectId, 'projectId');
      requireOptionalString(message.provider, 'provider');
      requireOptionalBoolean(message.forceRefresh, 'forceRefresh');
      return;
    case 'appCheck.getLimitedUseToken':
      requireOptionalString(message.appId, 'appId');
      requireOptionalString(message.projectId, 'projectId');
      requireOptionalString(message.provider, 'provider');
      return;
    case 'appCheck.consumeToken': {
      requireString(message.tokenId, 'tokenId');
      const tokenId = message.tokenId as string;
      const hasBoundedLength = tokenId.length > 0 && tokenId.length <= MAX_CONSUMED_TOKEN_ID_LENGTH;
      requireShape(hasBoundedLength, 'tokenId');
      return;
    }
  }
}
