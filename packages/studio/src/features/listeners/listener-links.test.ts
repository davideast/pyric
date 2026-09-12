/** The data-viewer and drill-in links the Listeners feature builds. */
import { describe, expect, it } from 'bun:test';
import {
  documentHref,
  drilledListenerId,
  listenerDrillHref,
  listenersTabHref,
} from './listener-links.js';

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

describe('the drill-in route', () => {
  it('is the listener id under the Traffic tab', () => {
    expect(listenerDrillHref('l-7')).toBe('/traffic/listeners/l-7');
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
