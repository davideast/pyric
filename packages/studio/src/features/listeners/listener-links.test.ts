/** The data-viewer and drill-in links the Listeners feature builds. */
import { describe, expect, it } from 'bun:test';
import {
  documentHref,
  drilledListenerId,
  listenerDrillTarget,
  listenersTabHref,
} from './listener-links.js';
import { hrefFor } from '../../shell/router.js';
import { parsePath } from '../../shell/path.js';
import { rtdbPathForLocation } from '../rtdb/routed-path.js';

describe('documentHref', () => {
  it('routes a Firestore path to the document route', () => {
    expect(documentHref('firestore', 'notes/one')).toBe('/firestore/notes/one');
  });

  it('routes a nested Firestore path through every segment', () => {
    expect(documentHref('firestore', 'notes/one/comments/two')).toBe(
      '/firestore/notes/one/comments/two',
    );
  });

  it('routes a database path to the rtdb route', () => {
    expect(documentHref('database', 'rooms/lobby/alice')).toBe('/rtdb/rooms/lobby/alice');
  });

  it('encodes a segment the app wrote with a space', () => {
    expect(documentHref('database', 'rooms/main lobby')).toBe('/rtdb/rooms/main%20lobby');
  });
});

describe('the database link the RTDB viewer honours', () => {
  it('names the path the viewer focuses', () => {
    const href = documentHref('database', 'rooms/lobby/alice');
    expect(href).toBe('/rtdb/rooms/lobby/alice');
    expect(rtdbPathForLocation(parsePath(href))).toBe('/rooms/lobby/alice');
  });

  it('names the viewer root for a delivered root path', () => {
    expect(rtdbPathForLocation(parsePath(documentHref('database', '/')))).toBe('/');
  });

  it('round-trips a segment the app wrote with a space', () => {
    const href = documentHref('database', 'rooms/main lobby');
    expect(rtdbPathForLocation(parsePath(href))).toBe('/rooms/main lobby');
  });
});

describe('the drill-in route', () => {
  it('is the listener id under the Traffic tab', () => {
    expect(hrefFor(listenerDrillTarget('l-7'))).toBe('/traffic/listeners/l-7');
  });

  it('goes back to the Listeners tab by its view parameter', () => {
    expect(listenersTabHref()).toBe('/traffic?view=listeners');
  });

  it('reads the listener out of a drilled location', () => {
    expect(drilledListenerId({ tab: 'traffic', rest: ['listeners', 'l-7'] })).toBe('l-7');
  });

  it('is not drilled on the Traffic tab itself', () => {
    expect(drilledListenerId({ tab: 'traffic', rest: [] })).toBeUndefined();
    expect(drilledListenerId({ tab: 'traffic', rest: ['listeners'] })).toBeUndefined();
  });

  it('is not drilled on another tab', () => {
    expect(drilledListenerId({ tab: 'firestore', rest: ['listeners', 'l-7'] })).toBeUndefined();
  });
});
