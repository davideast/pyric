import { z } from 'zod';
import { seedUserSchema } from '../internal/state-schemas.js';
import { isMessagingSnapshot } from '../../messaging/broker/persistence.js';

const authState = z.object({ users: z.array(seedUserSchema), providers: z.record(z.boolean()) });
const databaseState = z.object({
  '.pyricRtdbPersistence': z.literal(1),
  data: z.unknown().refine(value => value !== undefined, 'Required'),
  priorities: z.record(z.union([z.string(), z.number().finite()])),
  rules: z.object({ rules: z.record(z.unknown()) }).optional(),
  instances: z.record(z.unknown()).optional(),
});

export class UnsupportedPersistedServiceError extends Error {}

/** Hosted strict restore and explicit salvage use the same service validators. */
export function validatePersistedService(name: string, value: unknown): void {
  const isAuth = name === 'auth';
  if (isAuth) {
    authState.parse(value);
    return;
  }
  const isDatabase = name === 'rtdb';
  if (isDatabase) {
    const parsed = databaseState.parse(value);
    for (const instance of Object.values(parsed.instances ?? {})) databaseState.parse(instance);
    return;
  }
  const isMessaging = name === 'messaging';
  if (isMessaging) {
    const valid = isMessagingSnapshot(value);
    const invalidSnapshot = !valid;
    if (invalidSnapshot) throw new Error('Invalid persisted Messaging state.');
    return;
  }
  const noDurableState = name === 'storage' || name.startsWith('auth-session:');
  if (noDurableState) {
    const invalid = value !== null;
    if (invalid) throw new Error(`Unexpected persisted data for '${name}'.`);
    return;
  }
  throw new UnsupportedPersistedServiceError(`Unsupported persisted service '${name}'.`);
}

/** Empty service envelopes are not evidence that salvage recovered user state. */
export function persistedServiceHasData(name: string, value: unknown): boolean {
  const isAuth = name === 'auth';
  if (isAuth) {
    const auth = authState.parse(value);
    return auth.users.length > 0 || Object.keys(auth.providers).length > 0;
  }
  const isDatabase = name === 'rtdb';
  if (isDatabase) {
    const database = databaseState.parse(value);
    const hasData = containsDatabaseData(database.data);
    const hasInstanceData = Object.values(database.instances ?? {}).some(instance => persistedServiceHasData('rtdb', instance));
    return hasData || hasInstanceData;
  }
  const isMessaging = name === 'messaging' && isMessagingSnapshot(value);
  if (isMessaging) return value.tokens.length > 0 || value.topics.length > 0;
  return false;
}

function containsDatabaseData(value: unknown): boolean {
  const isNull = value === null;
  if (isNull) return false;
  const isObject = typeof value === 'object';
  if (isObject) return Object.values(value).some(containsDatabaseData);
  return true;
}
