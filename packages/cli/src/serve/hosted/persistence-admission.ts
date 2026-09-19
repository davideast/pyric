import { FirebaseError } from 'pyric/app';
import type { OpMessage } from '../worker/protocol.js';
import { operationPersistence } from '../worker/operation-persistence.js';

const persistencePolicy: Readonly<Record<OpMessage['method'], boolean>> = operationPersistence;

/** Mutations the hosted runtime must refuse while persistence is unhealthy. */
export function requiresHealthyPersistence(message: OpMessage): boolean {
  const method = message.method;
  const knownMethod = Object.hasOwn(persistencePolicy, method);
  if (!knownMethod) throw new FirebaseError('invalid-argument', `Unknown method: ${method}`);
  return persistencePolicy[method];
}
