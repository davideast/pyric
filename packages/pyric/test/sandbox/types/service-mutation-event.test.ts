/**
 * The cross-service mutation envelope binds `op` to the `service` beside it:
 * a service's own operations type-check, another service's do not.
 */
import { describe, it, expect } from 'bun:test';
import type {
  ServiceMutationEvent,
  ServiceMutationEventOf,
} from '../../../src/sandbox/types/service-mutation-event.js';

const AUTH_EVENT: ServiceMutationEventOf<'auth'> = {
  kind: 'service_mutation',
  id: 'e1',
  at: 1,
  service: 'auth',
  op: 'user_create',
  path: 'alice',
  auth: null,
};

describe('ServiceMutationEvent', () => {
  it('accepts an operation the service declared', () => {
    expect(AUTH_EVENT.op).toBe('user_create');
  });

  it('narrows op to the service when a consumer narrows on service', () => {
    const event: ServiceMutationEvent = AUTH_EVENT;
    expect(event.kind).toBe('service_mutation');
    if (event.service !== 'auth') throw new Error('expected the auth arm');
    // `event.op` is the auth operation union here, not `string`.
    const op: 'user_create' | 'user_update' | 'user_delete' | 'users_clear'
      | 'sign_in' | 'sign_out' | 'provider_config_update' = event.op;
    expect(op).toBe('user_create');
  });

  it("refuses an operation another service owns", () => {
    // @ts-expect-error 'object_put' belongs to storage, not auth.
    const wrong: ServiceMutationEventOf<'auth'> = { ...AUTH_EVENT, op: 'object_put' };
    expect(wrong.op).toBe('object_put');
  });
});
