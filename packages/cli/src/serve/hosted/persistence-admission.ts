import type { OpMessage } from '../worker/protocol.js';
import { isFirestoreWriteOp } from '../worker/host/firestore-writes.js';

/** Mutations the hosted runtime must refuse while persistence is unhealthy. */
export function requiresHealthyPersistence(message: OpMessage): boolean {
  switch (message.method) {
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
    default:
      return isFirestoreWriteOp(message.method);
  }
}
