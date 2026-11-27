import { assertQueryStructure } from '../host/query-structure.js';
import { assertAiArguments } from './operation-arguments.js';
import { assertAuthBlockingSubArguments } from './auth-blocking.js';
import { assertRtdbQuery } from './rtdb-query.js';
import { assertListenerOwners } from './listener-owners.js';
import { assertFirestoreSubDatabaseId } from './database-id.js';
import { requireRecord, requireShape, requireString, requireOptionalString, requireOptionalBoolean } from './fields.js';

/** Check target routing and adapter fields before retaining listener intent. */
export function assertSubscription(message: Record<string, unknown>): void {
  assertListenerOwners(message.owners);
  const target = message.target;
  const isNamedTarget = typeof target === 'string';
  if (isNamedTarget) {
    switch (target) {
      case 'events':
        requireOptionalString(message.tabId, 'tabId');
        requireOptionalString(message.clientId, 'clientId');
        return;
      case 'authState': case 'idToken':
      case 'presence':
        return;
      case 'authBlocking':
        assertAuthBlockingSubArguments(message);
        return;
      case 'messaging.foreground':
      case 'messaging.background':
      case 'messaging.registered':
      case 'messaging.unregistered':
        requireOptionalString(message.recipientId, 'recipientId');
        return;
      default:
        requireShape(false, 'target');
    }
  }
  requireRecord(target, 'target');
  switch (target.service) {
    case 'rtdb':
      requireString(target.path, 'target.path');
      requireOptionalString(target.instance, 'target.instance');
      requireOptionalString(target.event, 'target.event');
      assertRtdbQuery(target.query);
      return;
    case 'storage':
      requireOptionalString(target.bucket, 'target.bucket');
      requireOptionalString(target.defaultBucket, 'target.defaultBucket');
      return;
    case 'auth.lifecycle':
      return;
    case 'ai': {
      const isStream = target.op === 'streamGenerateContent';
      requireShape(isStream, 'target.op');
      assertAiArguments(message);
      return;
    }
    case 'firestore.writes':
      requireOptionalString(target.database, 'target.database');
      return;
    default:
      assertFirestoreSubDatabaseId(message, target);
      requireOptionalBoolean(message.includeMetadataChanges, 'includeMetadataChanges');
      assertQueryStructure(target);
  }
}
