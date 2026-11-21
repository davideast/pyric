import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  ACTIVE_FIRESTORE_EVENT_TYPES,
  DEFAULT_FIRESTORE_DATABASE,
  DEFAULT_FIRESTORE_NAMESPACE,
  DOCUMENT_CREATED_EVENT,
  DOCUMENT_CREATED_WITH_AUTH_EVENT,
  DOCUMENT_DELETED_EVENT,
  DOCUMENT_DELETED_WITH_AUTH_EVENT,
  DOCUMENT_UPDATED_EVENT,
  DOCUMENT_UPDATED_WITH_AUTH_EVENT,
  DOCUMENT_WRITTEN_EVENT,
  DOCUMENT_WRITTEN_WITH_AUTH_EVENT,
  FIRESTORE_EVENT_TYPES,
  discoverFirestoreTriggers,
  firestoreTriggersFamily,
  inspectFirestoreTriggers,
  isFirestoreTriggerEventType,
  type FirestoreTriggerEventType,
  type FirestoreTriggerOperation,
} from '../../src/functions/firestore/discovery.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const firestoreFunctions = requireFromConformance(
  'firebase-functions/v2/firestore',
) as typeof import('firebase-functions/v2/firestore');

describe('inspectFirestoreTriggers and firestoreTriggersFamily', () => {
  test('claims and inspects all 8 firebase-functions/v2/firestore trigger event types', () => {
    expect(FIRESTORE_EVENT_TYPES.length).toBe(8);
    expect(ACTIVE_FIRESTORE_EVENT_TYPES.has(DOCUMENT_CREATED_EVENT)).toBe(true);
    expect(ACTIVE_FIRESTORE_EVENT_TYPES.has(DOCUMENT_UPDATED_EVENT)).toBe(true);
    expect(ACTIVE_FIRESTORE_EVENT_TYPES.has(DOCUMENT_DELETED_EVENT)).toBe(true);
    expect(ACTIVE_FIRESTORE_EVENT_TYPES.has(DOCUMENT_WRITTEN_EVENT)).toBe(true);
    expect(isFirestoreTriggerEventType(DOCUMENT_CREATED_EVENT)).toBe(true);
    expect(isFirestoreTriggerEventType('google.firebase.database.ref.v1.created')).toBe(false);
    const expectedOps: readonly FirestoreTriggerOperation[] = [
      'created',
      'updated',
      'deleted',
      'written',
    ];
    const expectedTypes: readonly FirestoreTriggerEventType[] = FIRESTORE_EVENT_TYPES;
    expect(expectedOps.length).toBe(4);
    expect(expectedTypes.length).toBe(8);
    const exported = {
      created: firestoreFunctions.onDocumentCreated('users/{uid}', () => undefined),
      updated: firestoreFunctions.onDocumentUpdated('users/{uid}', () => undefined),
      deleted: firestoreFunctions.onDocumentDeleted('users/{uid}', () => undefined),
      written: firestoreFunctions.onDocumentWritten('users/{uid}', () => undefined),
      createdAuth: firestoreFunctions.onDocumentCreatedWithAuthContext(
        'users/{uid}',
        () => undefined,
      ),
      updatedAuth: firestoreFunctions.onDocumentUpdatedWithAuthContext(
        'users/{uid}',
        () => undefined,
      ),
      deletedAuth: firestoreFunctions.onDocumentDeletedWithAuthContext(
        'users/{uid}',
        () => undefined,
      ),
      writtenAuth: firestoreFunctions.onDocumentWrittenWithAuthContext(
        'users/{uid}',
        () => undefined,
      ),
    };

    for (const fn of Object.values(exported)) {
      const endpoint = (fn as unknown as { __endpoint: Record<string, unknown> }).__endpoint;
      expect(firestoreTriggersFamily.claims(endpoint)).toBe(true);
    }

    const inspected = inspectFirestoreTriggers(exported);
    expect(inspected.unsupported).toEqual([]);
    expect(
      inspected.triggers.map((t) => ({
        exportName: t.exportName,
        eventType: t.eventType,
        operation: t.operation,
        withAuthContext: t.withAuthContext,
        database: t.database,
        namespace: t.namespace,
      })),
    ).toEqual([
      {
        exportName: 'created',
        eventType: DOCUMENT_CREATED_EVENT,
        operation: 'created',
        withAuthContext: false,
        database: DEFAULT_FIRESTORE_DATABASE,
        namespace: DEFAULT_FIRESTORE_NAMESPACE,
      },
      {
        exportName: 'updated',
        eventType: DOCUMENT_UPDATED_EVENT,
        operation: 'updated',
        withAuthContext: false,
        database: DEFAULT_FIRESTORE_DATABASE,
        namespace: DEFAULT_FIRESTORE_NAMESPACE,
      },
      {
        exportName: 'deleted',
        eventType: DOCUMENT_DELETED_EVENT,
        operation: 'deleted',
        withAuthContext: false,
        database: DEFAULT_FIRESTORE_DATABASE,
        namespace: DEFAULT_FIRESTORE_NAMESPACE,
      },
      {
        exportName: 'written',
        eventType: DOCUMENT_WRITTEN_EVENT,
        operation: 'written',
        withAuthContext: false,
        database: DEFAULT_FIRESTORE_DATABASE,
        namespace: DEFAULT_FIRESTORE_NAMESPACE,
      },
      {
        exportName: 'createdAuth',
        eventType: DOCUMENT_CREATED_WITH_AUTH_EVENT,
        operation: 'created',
        withAuthContext: true,
        database: DEFAULT_FIRESTORE_DATABASE,
        namespace: DEFAULT_FIRESTORE_NAMESPACE,
      },
      {
        exportName: 'updatedAuth',
        eventType: DOCUMENT_UPDATED_WITH_AUTH_EVENT,
        operation: 'updated',
        withAuthContext: true,
        database: DEFAULT_FIRESTORE_DATABASE,
        namespace: DEFAULT_FIRESTORE_NAMESPACE,
      },
      {
        exportName: 'deletedAuth',
        eventType: DOCUMENT_DELETED_WITH_AUTH_EVENT,
        operation: 'deleted',
        withAuthContext: true,
        database: DEFAULT_FIRESTORE_DATABASE,
        namespace: DEFAULT_FIRESTORE_NAMESPACE,
      },
      {
        exportName: 'writtenAuth',
        eventType: DOCUMENT_WRITTEN_WITH_AUTH_EVENT,
        operation: 'written',
        withAuthContext: true,
        database: DEFAULT_FIRESTORE_DATABASE,
        namespace: DEFAULT_FIRESTORE_NAMESPACE,
      },
    ]);
  });

  test('discovers both literal eventFilters.document and wildcard eventFilterPathPatterns.document', () => {
    const literal = firestoreFunctions.onDocumentCreated('/config/singleton/', () => undefined);
    const wildcard = firestoreFunctions.onDocumentCreated(
      '/users/{userId}/orders/{orderId}/',
      () => undefined,
    );

    const discovered = discoverFirestoreTriggers({
      literal,
      nested: { wildcard },
    });

    expect(discovered).toEqual([
      {
        exportName: 'literal',
        eventType: DOCUMENT_CREATED_EVENT,
        operation: 'created',
        withAuthContext: false,
        document: 'config/singleton',
        database: '(default)',
        namespace: '(default)',
        callable: literal,
      },
      {
        exportName: 'nested-wildcard',
        eventType: DOCUMENT_CREATED_EVENT,
        operation: 'created',
        withAuthContext: false,
        document: 'users/{userId}/orders/{orderId}',
        database: '(default)',
        namespace: '(default)',
        callable: wildcard,
      },
    ]);
  });

  test('preserves named database, custom namespace, and non-default region metadata', () => {
    const analyticsCreate = firestoreFunctions.onDocumentCreated(
      {
        document: 'events/{eventId}',
        database: 'analytics',
        namespace: 'tenant-west',
        region: 'europe-west1',
      },
      () => undefined,
    );

    expect(discoverFirestoreTriggers({ analyticsCreate })).toEqual([
      {
        exportName: 'analyticsCreate',
        eventType: DOCUMENT_CREATED_EVENT,
        operation: 'created',
        withAuthContext: false,
        document: 'events/{eventId}',
        database: 'analytics',
        namespace: 'tenant-west',
        location: 'europe-west1',
        callable: analyticsCreate,
      },
    ]);
  });

  test('honors omit: true and reports invalid patterns or dynamic expressions without duplicate unclaimed labels', () => {
    const active = firestoreFunctions.onDocumentCreated('users/{uid}', () => undefined);
    const omitted = firestoreFunctions.onDocumentCreated(
      { document: 'users/{uid}', omit: true },
      () => undefined,
    );
    const collectionOnly = firestoreFunctions.onDocumentCreated('users', () => undefined);
    const dynamicDoc = firestoreFunctions.onDocumentCreated('users/{uid}', () => undefined);
    const dynamicTrigger = (
      dynamicDoc as unknown as {
        __endpoint: { eventTrigger: { eventFilterPathPatterns: Record<string, unknown> } };
      }
    ).__endpoint.eventTrigger;
    dynamicTrigger.eventFilterPathPatterns.document = { expression: 'DOC_PATH' };

    const dynamicDb = firestoreFunctions.onDocumentCreated('users/{uid}', () => undefined);
    const dynamicDbTrigger = (
      dynamicDb as unknown as {
        __endpoint: { eventTrigger: { eventFilters: Record<string, unknown> } };
      }
    ).__endpoint.eventTrigger;
    dynamicDbTrigger.eventFilters.database = { expression: 'DB_NAME' };

    const exported = { active, omitted, collectionOnly, dynamicDoc, dynamicDb };
    expect(discoverFirestoreTriggers(exported).map((t) => t.exportName)).toEqual(['active']);
    expect(findUnsupportedTriggers(exported, [firestoreTriggersFamily])).toEqual([
      {
        exportName: 'omitted',
        eventType: `${DOCUMENT_CREATED_EVENT} (omitted from emulation)`,
      },
      {
        exportName: 'collectionOnly',
        eventType: `${DOCUMENT_CREATED_EVENT} (unsupported document pattern: users)`,
      },
      {
        exportName: 'dynamicDoc',
        eventType: `${DOCUMENT_CREATED_EVENT} (unsupported dynamic document option)`,
      },
      {
        exportName: 'dynamicDb',
        eventType: `${DOCUMENT_CREATED_EVENT} (unsupported dynamic database option)`,
      },
    ]);
  });
});
