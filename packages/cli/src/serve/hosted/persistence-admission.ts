import { FirebaseError } from 'pyric/app';
import type { OpMessage } from '../worker/protocol.js';
import { isFirestoreWriteOp } from '../worker/host/firestore-writes.js';

/** Mutations the hosted runtime must refuse while persistence is unhealthy. */
export function requiresHealthyPersistence(message: OpMessage): boolean {
  const method = message.method;
  const isFirestoreWrite = isFirestoreWriteOp(method);
  if (isFirestoreWrite) return true;
  switch (method) {
    case 'messaging.getToken':
    case 'messaging.deleteToken':
    case 'messaging.subscribeToTopic':
    case 'messaging.unsubscribeFromTopic':
    case 'auth.createUser':
    case 'auth.signInAnonymously':
    case 'auth.signInWithCredential':
    case 'auth.acceptIdentity':
    case 'auth.updateProfile':
    case 'auth.updateEmail':
    case 'auth.updatePassword':
    case 'auth.deleteUser':
    case 'auth.adminCreateUser':
    case 'auth.adminUpdateUser':
    case 'auth.adminDeleteUser':
    case 'auth.adminClearUsers':
    case 'resetAll':
    case 'restore':
    case 'rtdb.set':
    case 'rtdb.remove':
    case 'storage.putBytes':
    case 'storage.deleteObject':
      return true;
    case 'getDoc':
    case 'getDocs':
    case 'count':
    case 'aggregate':
    case 'setRules':
    case 'setFirestoreRules':
    case 'setDatabaseRules':
    case 'getActiveRules':
    case 'getRulesStatus':
    case 'admin.getDocument':
    case 'admin.listDocuments':
    case 'admin.setDocument':
    case 'admin.deleteDocument':
    case 'admin.readState':
    case 'rtdb.get':
    case 'rtdb.setPriority':
    case 'rtdb.setWithPriority':
    case 'rtdb.update':
    case 'rtdb.push':
    case 'sandbox.clock':
    case 'rtdb.adminSnapshot':
    case 'rtdb.onDisconnectSet':
    case 'rtdb.onDisconnectUpdate':
    case 'rtdb.onDisconnectRemove':
    case 'rtdb.onDisconnectCancel':
    case 'rtdb.goOffline':
    case 'rtdb.goOnline':
    case 'rtdb.transactionCommit':
    case 'listRootCollections':
    case 'listSubcollections':
    case 'auth.signInEmail':
    case 'auth.signOut':
    case 'auth.getIdToken':
    case 'auth.getIdTokenResult':
    case 'auth.setPersistence':
    case 'auth.getCurrentUser':
    case 'auth.setTenantId':
    case 'auth.reload':
    case 'auth.updateCurrentUser':
    case 'auth.restorePortSession':
    case 'auth.listUsers':
    case 'auth.getProviderConfig':
    case 'auth.setProviderConfig':
    case 'storage.listAll':
    case 'storage.getMetadata':
    case 'storage.getBlob':
    case 'storage.getBytes':
    case 'ai.generateContent':
    case 'ai.countTokens':
    case 'getRuntimeEpoch':
    case 'retireRuntime':
    case 'getVersion':
    case 'exportState':
    case 'importState':
    case 'checkpoint':
    case 'listCheckpoints':
    case 'deleteCheckpoint':
    case 'getSnapshot':
    case 'messaging.send':
    case 'messaging.deliver':
    case 'messaging.acknowledge':
    case 'messaging.setVisibility':
    case 'presence.register':
    case 'presence.heartbeat':
    case 'presence.update':
    case 'presence.disconnect':
      return false;
    default: {
      const unsupportedMethod: never = method;
      throw new FirebaseError('invalid-argument', `Unknown sandbox method: ${unsupportedMethod}.`);
    }
  }
}
