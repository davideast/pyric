/** What the messaging surface declares it puts on the sandbox event stream. */
import { describe, it, expect } from 'bun:test';
import { MESSAGING_EVENT_RECORD } from '../../src/messaging/events.js';

describe('messaging event record', () => {
  it('declares the service name the stream attributes its events to', () => {
    expect(MESSAGING_EVENT_RECORD.service).toBe('messaging');
  });

  it('enumerates every operation it emits', () => {
    expect([...MESSAGING_EVENT_RECORD.operations]).toEqual([
      'token_minted',
      'token_deleted',
      'subscription_changed',
      'message_accepted',
      'message_rejected',
      'delivery_routed',
      'message_delivered',
    ]);
  });

  it('names what the event path addresses', () => {
    expect(MESSAGING_EVENT_RECORD.target.name).toBe('token');
  });
});
