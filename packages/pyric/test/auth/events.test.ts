/** What the auth surface declares it puts on the sandbox event stream. */
import { describe, it, expect } from 'bun:test';
import { AUTH_EVENT_RECORD } from '../../src/auth/events.js';

describe('auth event record', () => {
  it('declares the service name the stream attributes its events to', () => {
    expect(AUTH_EVENT_RECORD.service).toBe('auth');
  });

  it('enumerates every operation it emits', () => {
    expect([...AUTH_EVENT_RECORD.operations]).toEqual([
      'user_create',
      'user_update',
      'user_delete',
      'users_clear',
      'sign_in',
      'sign_out',
      'provider_config_update',
    ]);
  });

  it('names what the event path addresses', () => {
    expect(AUTH_EVENT_RECORD.target.name).toBe('uid');
  });
});
