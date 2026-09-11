/** What the storage surface declares it puts on the sandbox event stream. */
import { describe, it, expect } from 'bun:test';
import { STORAGE_EVENT_RECORD } from '../../src/storage/events.js';

describe('storage event record', () => {
  it('declares the service name the stream attributes its events to', () => {
    expect(STORAGE_EVENT_RECORD.service).toBe('storage');
  });

  it('enumerates every operation it emits', () => {
    expect([...STORAGE_EVENT_RECORD.operations]).toEqual([
      'object_put',
      'object_delete',
      'metadata_update',
    ]);
  });

  it('names what the event path addresses', () => {
    expect(STORAGE_EVENT_RECORD.target.name).toBe('fullPath');
  });
});
