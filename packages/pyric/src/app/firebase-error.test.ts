import { describe, expect, it } from 'bun:test';

import { FirebaseError } from './firebase-error.js';

describe('FirebaseError mirror', () => {
  it('preserves the Firebase error shape for direct and subclass instances', () => {
    const customData = { operation: 'probe' };
    const error = new FirebaseError('app/probe', 'probe message', customData);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(FirebaseError);
    expect(error.name).toBe('FirebaseError');
    expect(error.constructor.name).toBe('FirebaseError');
    expect(error.code).toBe('app/probe');
    expect(error.message).toBe('probe message');
    expect(error.customData).toBe(customData);

    class ServiceError extends FirebaseError {}
    const serviceError = new ServiceError('service/probe', 'service message');
    expect(serviceError).toBeInstanceOf(ServiceError);
    expect(serviceError).toBeInstanceOf(FirebaseError);
    expect(serviceError.code).toBe('service/probe');
  });
});
