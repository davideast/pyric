import { describe, expect, it } from 'bun:test';
import {
  LISTENERS_VIEW_COPY,
  LISTENER_PAGE_COPY,
} from '../../../src/features/listeners/listeners-copy.js';

describe('listeners-copy', () => {
  it('provides distinct sandbox and live source lines for ListenersView and ListenerPage', () => {
    expect(LISTENERS_VIEW_COPY.sandbox.source).toContain('sandbox listener events');
    expect(LISTENERS_VIEW_COPY.live.source).toContain('observed live listeners');
    expect(LISTENER_PAGE_COPY.sandbox.source).toContain('sandbox delivery events');
    expect(LISTENER_PAGE_COPY.live.source).toContain('observed live deliveries');
  });
});
