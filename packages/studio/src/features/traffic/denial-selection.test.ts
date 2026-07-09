/**
 * Traffic denial selection ↔ URL query: pure round-trip tests.
 *
 * The open denial lives in `?denial=<id>` (the key `shell/path.ts` documents
 * and the command palette targets). These tests pin:
 *   1. select/close/toggle semantics over the query record (other keys survive);
 *   2. the full URL round-trip through the shared path codec (`serializePath`
 *      → `parsePath` → `selectedDenialId`), including ids that need encoding —
 *      exactly the deep-link the palette emits.
 */

import { describe, it, expect } from 'bun:test';
import { parsePath, serializePath } from '../../shell/path.js';
import {
  DENIAL_PARAM,
  queryWithDenial,
  selectedDenialId,
  toggleDenial,
} from './denial-selection.js';

describe('denial selection: query record semantics', () => {
  it('reads the selected id, treating absent/empty as none', () => {
    expect(selectedDenialId({})).toBeNull();
    expect(selectedDenialId({ denial: '' })).toBeNull();
    expect(selectedDenialId({ denial: 'req-7' })).toBe('req-7');
  });

  it('selects and closes while preserving unrelated keys, without mutating', () => {
    const base = { other: 'kept' };
    const open = queryWithDenial(base, 'req-7');
    expect(open).toEqual({ other: 'kept', denial: 'req-7' });
    const closed = queryWithDenial(open, null);
    expect(closed).toEqual({ other: 'kept' });
    // Inputs untouched (the surface hands these straight to pushPath).
    expect(base).toEqual({ other: 'kept' });
    expect(open).toEqual({ other: 'kept', denial: 'req-7' });
  });

  it('toggle: clicking the open denial closes it; another id switches focus', () => {
    const open = toggleDenial({}, 'req-7');
    expect(selectedDenialId(open)).toBe('req-7');
    expect(selectedDenialId(toggleDenial(open, 'req-7'))).toBeNull();
    expect(selectedDenialId(toggleDenial(open, 'req-9'))).toBe('req-9');
  });
});

describe('denial selection: URL round-trip through the path codec', () => {
  it('serializes to ?denial=<id> on the traffic tab and parses back', () => {
    const url = serializePath(
      { tab: 'traffic', query: queryWithDenial({}, 'req-7') },
      '/',
    );
    expect(url).toBe(`/traffic?${DENIAL_PARAM}=req-7`);
    const qIdx = url.indexOf('?');
    const parsed = parsePath(url.slice(0, qIdx), url.slice(qIdx), '/');
    expect(parsed.tab).toBe('traffic');
    expect(selectedDenialId(parsed.query)).toBe('req-7');
  });

  it('round-trips ids that need URL encoding', () => {
    const id = 'req 7/α';
    const url = serializePath({ tab: 'traffic', query: { denial: id } }, '/');
    const qIdx = url.indexOf('?');
    const parsed = parsePath(url.slice(0, qIdx), url.slice(qIdx), '/');
    expect(selectedDenialId(parsed.query)).toBe(id);
  });

  it('closing drops the param entirely (no dangling ?denial=)', () => {
    const url = serializePath(
      { tab: 'traffic', query: queryWithDenial({ denial: 'req-7' }, null) },
      '/',
    );
    expect(url).toBe('/traffic');
  });

  it('matches the command palette deep-link shape ({tab:traffic, query:{denial}})', () => {
    // features/home/command.ts emits exactly this target for denial ids.
    const target = { tab: 'traffic', query: { denial: 'req-42' } };
    const url = serializePath(target, '/');
    const qIdx = url.indexOf('?');
    const parsed = parsePath(url.slice(0, qIdx), url.slice(qIdx), '/');
    expect(selectedDenialId(parsed.query)).toBe('req-42');
  });
});
