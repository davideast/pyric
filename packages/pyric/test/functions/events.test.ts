/** What the Functions trigger runtime declares it puts on the sandbox event stream. */
import { describe, it, expect } from 'bun:test';
import { FUNCTIONS_EVENT_RECORD } from '../../src/functions/events.js';

describe('functions event record', () => {
  it('declares the service name the stream attributes its events to', () => {
    expect(FUNCTIONS_EVENT_RECORD.service).toBe('functions');
  });

  it('enumerates every operation it emits', () => {
    expect([...FUNCTIONS_EVENT_RECORD.operations]).toEqual([
      'trigger_discovered',
      'handler_fired',
      'execution_finished',
    ]);
  });

  it('names what the event path addresses', () => {
    expect(FUNCTIONS_EVENT_RECORD.target.name).toBe('ref');
  });
});
