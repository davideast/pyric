/** What the Realtime Database surface declares it puts on the sandbox event stream. */
import { describe, it, expect } from 'bun:test';
import { RTDB_EVENT_RECORD } from '../../src/database/events.js';

describe('rtdb event record', () => {
  it('declares the service name the stream attributes its events to', () => {
    expect(RTDB_EVENT_RECORD.service).toBe('rtdb');
  });

  it('enumerates every operation it emits', () => {
    expect([...RTDB_EVENT_RECORD.operations]).toEqual([
      'set',
      'update',
      'remove',
      'transaction',
      'setPriority',
    ]);
  });

  it('names what the event path addresses', () => {
    expect(RTDB_EVENT_RECORD.target.name).toBe('path');
  });
});
