import { FirebaseError } from 'pyric/app';
import type { OpMessage } from '../protocol.js';
import { DELIVERY_STAGES } from 'pyric/messaging/internal';
import { requireDocumentData } from 'pyric/firestore/internal/value-codec';
import { requireFirestorePath } from '../protocol/firestore-validation.js';
import { isMessageRecord, requireShape, requireRecord, requireString, requireOptionalString,
  requireOptionalBoolean, requireOptionalRecord } from './fields.js';
import { assertRtdbQuery } from './rtdb-query.js';
export { isMessageRecord } from './fields.js';

function assertRequiredPath(message: Record<string, unknown>): void {
  switch (message.method) {
    case 'getDoc': case 'setDoc': case 'updateDoc': case 'deleteDoc':
    case 'admin.getDocument': case 'admin.listDocuments': case 'admin.setDocument': case 'admin.deleteDocument':
      requireFirestorePath(message.path);
      return;
    case 'rtdb.get': case 'rtdb.set': case 'rtdb.setPriority': case 'rtdb.setWithPriority':
    case 'rtdb.update': case 'rtdb.remove': case 'rtdb.push': case 'rtdb.transactionCommit':
    case 'rtdb.onDisconnectSet': case 'rtdb.onDisconnectUpdate': case 'rtdb.onDisconnectRemove': case 'rtdb.onDisconnectCancel':
    case 'storage.listAll': case 'storage.getMetadata': case 'storage.getBlob':
    case 'storage.getBytes': case 'storage.deleteObject': case 'storage.putBytes':
      requireString(message.path, 'path');
      return;
  }
}

function assertSharedAuthFields(message: Record<string, unknown>): void {
  const method = message.method;
  const isAuthMethod = typeof method === 'string' && method.startsWith('auth.');
  const isOtherService = !isAuthMethod;
  if (isOtherService) return;
  const tenant = message.tenantId;
  const hasValidTenant = tenant === undefined || tenant === null || typeof tenant === 'string';
  requireShape(hasValidTenant, 'tenantId');
  requireOptionalBoolean(message.forceRefresh, 'forceRefresh');
}

function assertSetOptions(value: unknown): void {
  const isAbsent = value === undefined;
  if (isAbsent) return;
  requireRecord(value, 'options');
  requireOptionalBoolean(value.merge, 'options.merge');
  const fields = value.mergeFields;
  const hasFields = fields !== undefined;
  if (hasFields) {
    const isFieldList = Array.isArray(fields) && fields.every(field => typeof field === 'string');
    requireShape(isFieldList, 'options.mergeFields');
  }
}

/** Validate adapter-owned argument shapes; service validators retain value semantics. */
export function assertOperationArguments(message: Record<string, unknown>): void {
  requireOptionalString(message.clientSessionId, 'clientSessionId');
  requireOptionalBoolean(message.resumeSession, 'resumeSession');
  assertRequiredPath(message);
  assertSharedAuthFields(message);
  // Only the dispatch is typed; each payload field remains untrusted.
  // The default refuses methods outside the protocol at runtime.
  const method = message.method as OpMessage['method'];
  switch (method) {
    case 'addDoc':
      requireFirestorePath(message.collectionPath);
      requireDocumentData(message.data);
      return;
    case 'setDoc':
      requireDocumentData(message.data);
      assertSetOptions(message.options);
      return;
    case 'updateDoc':
    case 'admin.setDocument':
      requireDocumentData(message.data);
      return;
    case 'getActiveRules':
    case 'getRulesStatus': {
      const hasSupportedService = message.service === undefined || message.service === 'firestore' || message.service === 'database';
      requireShape(hasSupportedService, 'service');
      return;
    }
    case 'checkpoint':
    case 'restore':
    case 'deleteCheckpoint': {
      const hasName = typeof message.name === 'string';
      requireShape(hasName, 'name');
      return;
    }
    case 'admin.readState': {
      const depth = message.maxDepth;
      const hasValidDepth = depth === undefined || typeof depth === 'number' && Number.isFinite(depth);
      requireShape(hasValidDepth, 'maxDepth');
      return;
    }
    case 'rtdb.get':
      assertRtdbQuery(message.query);
      return;
    case 'rtdb.update':
    case 'rtdb.onDisconnectUpdate': {
      const hasValues = isMessageRecord(message.values);
      requireShape(hasValues, 'values');
      return;
    }
    case 'rtdb.push': {
      const hasValidKey = message.key === undefined || typeof message.key === 'string';
      requireShape(hasValidKey, 'key');
      return;
    }
    case 'auth.setPersistence': {
      const hasSupportedMode = message.mode === 'LOCAL' || message.mode === 'SESSION' || message.mode === 'NONE';
      requireShape(hasSupportedMode, 'mode');
      return;
    }
    case 'auth.setTenantId': {
      const hasTenantId = message.tenantId === null || typeof message.tenantId === 'string';
      requireShape(hasTenantId, 'tenantId');
      return;
    }
    case 'auth.setProviderConfig': {
      requireString(message.providerId, 'providerId');
      const hasEnabledFlag = typeof message.enabled === 'boolean';
      requireShape(hasEnabledFlag, 'enabled');
      return;
    }
    case 'storage.putBytes':
      requireOptionalRecord(message.metadata, 'metadata');
      requireOptionalString(message.contentType, 'contentType');
      return;
    case 'ai.generateContent':
    case 'ai.countTokens':
      assertAiArguments(message);
      return;
    case 'messaging.deliver': {
      requireOptionalString(message.recipientId, 'recipientId');
      const spec = message.spec;
      requireRecord(spec, 'spec');
      const visibility = spec.visibilityState;
      const hasValidVisibility = visibility === undefined || visibility === 'visible' || visibility === 'hidden';
      requireShape(hasValidVisibility, 'spec.visibilityState');
      const data = spec.data;
      const hasData = data !== undefined;
      if (hasData) {
        requireRecord(data, 'spec.data');
        const hasStringValues = Object.values(data).every(value => typeof value === 'string');
        requireShape(hasStringValues, 'spec.data');
      }
      const notification = spec.notification;
      const hasNotification = notification !== undefined;
      if (hasNotification) {
        requireRecord(notification, 'spec.notification');
        requireOptionalString(notification.title, 'spec.notification.title');
        requireOptionalString(notification.body, 'spec.notification.body');
        requireOptionalString(notification.image, 'spec.notification.image');
      }
      requireOptionalString(spec.from, 'spec.from');
      requireOptionalString(spec.messageId, 'spec.messageId');
      return;
    }
    case 'messaging.setVisibility': {
      requireOptionalString(message.recipientId, 'recipientId');
      const hasSupportedState = message.state === 'visible' || message.state === 'hidden';
      requireShape(hasSupportedState, 'state');
      return;
    }
    case 'presence.register': {
      requireString(message.clientId, 'clientId');
      requireString(message.route, 'route');
      const hasSupportedVisibility = message.visibility === 'visible' || message.visibility === 'hidden';
      requireShape(hasSupportedVisibility, 'visibility');
      return;
    }
    case 'aggregate': {
      const spec = message.spec;
      requireRecord(spec, 'spec');
      for (const aggregate of Object.values(spec)) {
        requireRecord(aggregate, 'aggregate');
        const isCount = aggregate.kind === 'count';
        const isKnownKind = isCount || aggregate.kind === 'sum' || aggregate.kind === 'average';
        requireShape(isKnownKind, 'aggregate.kind');
        const needsField = !isCount;
        if (needsField) requireString(aggregate.field, 'aggregate.field');
      }
      return;
    }
    case 'rtdb.transactionCommit': {
      const hasExpected = message.expected !== undefined;
      requireShape(hasExpected, 'expected');
      const hasValue = message.value !== undefined;
      requireShape(hasValue, 'value');
      return;
    }
    case 'rtdb.set':
    case 'rtdb.setWithPriority':
    case 'rtdb.onDisconnectSet': {
      const hasValue = message.value !== undefined;
      requireShape(hasValue, 'value');
      return;
    }
    case 'auth.updateProfile': {
      const displayName = message.displayName;
      const hasDisplayName = displayName === undefined || displayName === null || typeof displayName === 'string';
      requireShape(hasDisplayName, 'displayName');
      const photoURL = message.photoURL;
      const hasPhotoURL = photoURL === undefined || photoURL === null || typeof photoURL === 'string';
      requireShape(hasPhotoURL, 'photoURL');
      return;
    }
    case 'auth.signInWithCredential': {
      const credential = message.credential ?? message;
      requireRecord(credential, 'credential');
      requireString(credential.providerId, 'credential.providerId');
      for (const field of ['uid', 'email', 'displayName', 'photoURL', 'idToken', 'accessToken', 'rawNonce']) {
        const value = credential[field];
        const isNullableString = value === undefined || value === null || typeof value === 'string';
        requireShape(isNullableString, `credential.${field}`);
      }
      return;
    }
    case 'auth.acceptIdentity': {
      const identity = message.identity;
      requireRecord(identity, 'identity');
      requireString(identity.uid, 'identity.uid');
      requireString(identity.providerId, 'identity.providerId');
      for (const field of ['email', 'displayName', 'photoURL']) {
        const value = identity[field];
        const isNullableString = value === undefined || value === null || typeof value === 'string';
        requireShape(isNullableString, `identity.${field}`);
      }
      requireOptionalRecord(identity.customClaims, 'identity.customClaims');
      return;
    }
    case 'auth.adminCreateUser':
      requireRecord(message.request, 'request');
      return;
    case 'auth.adminUpdateUser':
      requireString(message.uid, 'uid');
      requireRecord(message.request, 'request');
      return;
    case 'auth.adminDeleteUser':
    case 'auth.restorePortSession':
      requireString(message.uid, 'uid');
      return;
    case 'messaging.acknowledge': {
      requireString(message.subId, 'subId');
      requireString(message.messageId, 'messageId');
      const validStage = DELIVERY_STAGES.some(stage => stage === message.stage);
      requireShape(validStage, 'stage');
      return;
    }
    case 'messaging.send':
      requireOptionalBoolean(message.validateOnly, 'validateOnly');
      return;
    case 'messaging.getToken':
    case 'messaging.deleteToken':
      requireOptionalString(message.recipientId, 'recipientId');
      requireOptionalString(message.registrationId, 'registrationId');
      return;
    case 'presence.heartbeat':
    case 'presence.disconnect':
      requireString(message.clientId, 'clientId');
      return;
    case 'presence.update': {
      requireString(message.clientId, 'clientId');
      requireOptionalString(message.route, 'route');
      const visibility = message.visibility;
      const hasValidVisibility = visibility === undefined || visibility === 'visible' || visibility === 'hidden';
      requireShape(hasValidVisibility, 'visibility');
      return;
    }
    case 'getDoc':
    case 'getDocs':
    case 'deleteDoc':
    case 'count':
    case 'batchCommit':
    case 'txnCommit':
    case 'setRules':
    case 'setFirestoreRules':
    case 'setDatabaseRules':
    case 'admin.getDocument':
    case 'admin.listDocuments':
    case 'admin.deleteDocument':
    case 'rtdb.setPriority':
    case 'rtdb.remove':
    case 'sandbox.clock':
    case 'rtdb.adminSnapshot':
    case 'rtdb.onDisconnectRemove':
    case 'rtdb.onDisconnectCancel':
    case 'rtdb.goOffline':
    case 'rtdb.goOnline':
    case 'listRootCollections':
    case 'listSubcollections':
    case 'auth.createUser':
    case 'auth.signInEmail':
    case 'auth.signInAnonymously':
    case 'auth.signOut':
    case 'auth.getIdToken':
    case 'auth.getIdTokenResult':
    case 'auth.getCurrentUser':
    case 'auth.reload':
    case 'auth.deleteUser':
    case 'auth.updateEmail':
    case 'auth.updatePassword':
    case 'auth.updateCurrentUser':
    case 'auth.listUsers':
    case 'auth.adminClearUsers':
    case 'auth.getProviderConfig':
    case 'storage.listAll':
    case 'storage.getMetadata':
    case 'storage.getBlob':
    case 'storage.getBytes':
    case 'storage.deleteObject':
    case 'getRuntimeEpoch':
    case 'retireRuntime':
    case 'getVersion':
    case 'exportState':
    case 'importState':
    case 'listCheckpoints':
    case 'getSnapshot':
    case 'resetAll':
    case 'messaging.subscribeToTopic':
    case 'messaging.unsubscribeFromTopic':
      return;
    default: {
      const unsupportedMethod: never = method;
      throw new FirebaseError('invalid-argument', `Unknown sandbox method: ${unsupportedMethod}.`);
    }
  }
}


/** Unary and streaming AI requests share the same adapter-owned wire fields. */
export function assertAiArguments(message: Record<string, unknown>): void {
  requireString(message.model, 'model');
  requireRecord(message.request, 'request');
  const engine = message.engine;
  const hasNoEngine = engine === undefined;
  if (hasNoEngine) return;
  requireRecord(engine, 'engine');
  const hasSupportedEngine = engine.kind === 'scripted' || engine.kind === 'openai' || engine.kind === 'gemini';
  requireShape(hasSupportedEngine, 'engine.kind');
  switch (engine.kind) {
    case 'scripted': {
      const script = engine.script;
      const hasScript = script !== undefined;
      if (hasScript) {
        const isScript = Array.isArray(script) && script.every(isMessageRecord);
        requireShape(isScript, 'engine.script');
      }
      return;
    }
    case 'openai': {
      requireOptionalString(engine.baseUrl, 'engine.baseUrl');
      requireOptionalString(engine.model, 'engine.model');
      const modelMap = engine.modelMap;
      const hasModelMap = modelMap !== undefined;
      if (hasModelMap) {
        requireRecord(modelMap, 'engine.modelMap');
        const hasStringModels = Object.values(modelMap).every(model => typeof model === 'string');
        requireShape(hasStringModels, 'engine.modelMap');
      }
      return;
    }
    case 'gemini':
      requireOptionalString(engine.baseUrl, 'engine.baseUrl');
      requireOptionalString(engine.apiKey, 'engine.apiKey');
      return;
  }
}
