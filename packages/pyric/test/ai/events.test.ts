/** What the AI surface declares it puts on the sandbox event stream. */
import { describe, it, expect } from 'bun:test';
import { AI_EVENT_RECORD } from '../../src/ai/events.js';

describe('ai event record', () => {
  it('declares the service name the stream attributes its events to', () => {
    expect(AI_EVENT_RECORD.service).toBe('ai');
  });

  it('enumerates every operation it emits', () => {
    expect([...AI_EVENT_RECORD.operations]).toEqual([
      'generate_content',
      'stream_generate_content',
      'count_tokens',
      'request_rejected',
      'response_blocked',
      'model_substituted',
    ]);
  });

  it('names what the event path addresses', () => {
    expect(AI_EVENT_RECORD.target.name).toBe('model');
  });
});
