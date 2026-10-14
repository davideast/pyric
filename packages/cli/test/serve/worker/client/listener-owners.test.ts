/** The owners a served page records for a listener, before the subscribe crosses the port. */
import { afterEach, describe, expect, it } from 'bun:test';
import { configureListenerOwnerFrames } from 'pyric/sandbox/internal';
import { watch } from './fixtures/data-layer.js';

// Not a tail call: JavaScriptCore drops a tail caller's frame.
function listRooms(owner?: string): ReturnType<typeof watch> {
  const owners = [watch(owner)];
  return owners[0];
}

afterEach(() => {
  configureListenerOwnerFrames({});
});

describe('pageListenerOwners', () => {
  it('records the application frames around the call, innermost first', () => {
    const [frame] = listRooms() ?? [];
    if (frame?.kind !== 'frame') throw new Error('expected a frame owner');
    expect(frame.function).toBe('watch');
    expect(frame.stack?.map((entry) => entry.function).slice(0, 2)).toEqual(['watch', 'listRooms']);
  });

  it('shows the first frame outside a skipped module, as the in-page sandbox does', () => {
    configureListenerOwnerFrames({ skip: ['**/fixtures/data-layer.ts'], frames: 1 });
    const [frame, tag] = listRooms('rooms') ?? [];
    if (frame?.kind !== 'frame') throw new Error('expected a frame owner');
    expect(frame.function).toBe('listRooms');
    expect(frame.file).toEndWith('/listener-owners.test.ts');
    expect(frame.stack?.map((entry) => entry.function)).toEqual(['watch', 'listRooms']);
    expect(tag).toEqual({ kind: 'tag', name: 'rooms' });
  });
});
