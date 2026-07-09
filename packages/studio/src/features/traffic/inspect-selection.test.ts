/**
 * Traffic rules-inspector selection ↔ URL query: pure round-trip tests.
 *
 * The inspected op lives in `?inspect=<id>` (the key `shell/path.ts` documents
 * and the command palette targets — renamed from `denial` when the inspector
 * generalized to allowed ops). These tests pin:
 *   1. select/close/toggle semantics over the query record (other keys survive);
 *   2. the full URL round-trip through the shared path codec (`serializePath`
 *      → `parsePath` → `selectedInspectId`), including ids that need encoding —
 *      exactly the deep-link the palette emits.
 */

import { describe, it, expect } from 'bun:test';
import { parsePath, serializePath } from '../../shell/path.js';
import {
  INSPECT_PARAM,
  queryWithInspect,
  selectedInspectId,
  toggleInspect,
} from './inspect-selection.js';

describe('inspector selection: query record semantics', () => {
  it('reads the selected id, treating absent/empty as none', () => {
    expect(selectedInspectId({})).toBeNull();
    expect(selectedInspectId({ inspect: '' })).toBeNull();
    expect(selectedInspectId({ inspect: 'req-7' })).toBe('req-7');
  });

  it('selects and closes while preserving unrelated keys, without mutating', () => {
    const base = { other: 'kept' };
    const open = queryWithInspect(base, 'req-7');
    expect(open).toEqual({ other: 'kept', inspect: 'req-7' });
    const closed = queryWithInspect(open, null);
    expect(closed).toEqual({ other: 'kept' });
    // Inputs untouched (the surface hands these straight to pushPath).
    expect(base).toEqual({ other: 'kept' });
    expect(open).toEqual({ other: 'kept', inspect: 'req-7' });
  });

  it('toggle: clicking the inspected row closes it; another id switches focus', () => {
    const open = toggleInspect({}, 'req-7');
    expect(selectedInspectId(open)).toBe('req-7');
    expect(selectedInspectId(toggleInspect(open, 'req-7'))).toBeNull();
    expect(selectedInspectId(toggleInspect(open, 'req-9'))).toBe('req-9');
  });
});

describe('inspector selection: URL round-trip through the path codec', () => {
  it('serializes to ?inspect=<id> on the traffic tab and parses back', () => {
    const url = serializePath(
      { tab: 'traffic', query: queryWithInspect({}, 'req-7') },
      '/',
    );
    expect(url).toBe(`/traffic?${INSPECT_PARAM}=req-7`);
    const qIdx = url.indexOf('?');
    const parsed = parsePath(url.slice(0, qIdx), url.slice(qIdx), '/');
    expect(parsed.tab).toBe('traffic');
    expect(selectedInspectId(parsed.query)).toBe('req-7');
  });

  it('round-trips ids that need URL encoding', () => {
    const id = 'req 7/α';
    const url = serializePath({ tab: 'traffic', query: { inspect: id } }, '/');
    const qIdx = url.indexOf('?');
    const parsed = parsePath(url.slice(0, qIdx), url.slice(qIdx), '/');
    expect(selectedInspectId(parsed.query)).toBe(id);
  });

  it('closing drops the param entirely (no dangling ?inspect=)', () => {
    const url = serializePath(
      { tab: 'traffic', query: queryWithInspect({ inspect: 'req-7' }, null) },
      '/',
    );
    expect(url).toBe('/traffic');
  });

  it('matches the command palette deep-link shape ({tab:traffic, query:{inspect}})', () => {
    // features/home/command.ts emits exactly this target for traffic event ids.
    const target = { tab: 'traffic', query: { inspect: 'req-42' } };
    const url = serializePath(target, '/');
    const qIdx = url.indexOf('?');
    const parsed = parsePath(url.slice(0, qIdx), url.slice(qIdx), '/');
    expect(selectedInspectId(parsed.query)).toBe('req-42');
  });
});
