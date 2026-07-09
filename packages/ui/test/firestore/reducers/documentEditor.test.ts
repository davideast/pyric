import { describe, it, expect } from 'bun:test';
import { Timestamp, GeoPoint } from 'pyric/firestore';
import {
  initState,
  reducer,
} from '../../../src/firestore/reducers/documentEditor.js';
import { treeToData } from '../../../src/firestore/reducers/tree.js';
import type { FieldNode } from '../../../src/firestore/reducers/types.js';

function findChild(state: ReturnType<typeof initState>, key: string): FieldNode {
  const { tree } = state;
  const id = (tree.childIds[tree.rootId] ?? []).find(
    (cid) => tree.nodes[cid]?.key === key,
  );
  if (!id) throw new Error(`No child with key ${key}`);
  return tree.nodes[id];
}

describe('documentEditor reducer', () => {
  it('initial state has zero errors for valid data', () => {
    const state = initState({ name: 'Alice', score: 42 });
    expect(state.errorCount).toBe(0);
  });

  it('rehydrates serialized Timestamp/GeoPoint so the editor opens without false errors', () => {
    // These arrive as plain shapes over the worker boundary; without rehydration
    // the instanceof validators would report "Expected a Timestamp/GeoPoint".
    const state = initState({
      createdAt: { seconds: 1781825935, nanoseconds: 502000000 },
      location: { latitude: 37.7749, longitude: -122.4194 },
      embedding: { __type__: '__vector__', value: [0.1, 0.2, 0.3] },
    });
    expect(state.errorCount).toBe(0);
    const data = treeToData(state.tree) as Record<string, unknown>;
    expect(data.createdAt instanceof Timestamp).toBe(true);
    expect(data.location instanceof GeoPoint).toBe(true);
    expect((data.location as GeoPoint).latitude).toBe(37.7749);
    // the vector stays the wire sentinel (no Vector constructor)
    expect(data.embedding).toEqual({ __type__: '__vector__', value: [0.1, 0.2, 0.3] });
  });

  it('setValue updates a leaf', () => {
    let state = initState({ name: 'Alice' });
    const nameNode = findChild(state, 'name');
    state = reducer(state, { type: 'setValue', nodeId: nameNode.id, value: 'Bob' });
    expect(findChild(state, 'name').value).toBe('Bob');
  });

  it('setValue is a no-op on container nodes', () => {
    let state = initState({ users: [{ name: 'A' }] });
    const users = findChild(state, 'users');
    state = reducer(state, { type: 'setValue', nodeId: users.id, value: 'whatever' });
    // The container's value should stay undefined.
    expect(state.tree.nodes[users.id].value).toBeUndefined();
  });

  it('setType switches a leaf and resets value to the new default', () => {
    let state = initState({ count: 5 });
    const count = findChild(state, 'count');
    state = reducer(state, { type: 'setType', nodeId: count.id, newType: 'string' });
    const updated = findChild(state, 'count');
    expect(updated.type).toBe('string');
    expect(updated.value).toBe('');
  });

  it('setType to map empties children', () => {
    let state = initState({ tags: ['a', 'b'] });
    const tags = findChild(state, 'tags');
    state = reducer(state, { type: 'setType', nodeId: tags.id, newType: 'map' });
    const updated = findChild(state, 'tags');
    expect(updated.type).toBe('map');
    expect(state.tree.childIds[updated.id]).toEqual([]);
  });

  it('setType cannot move the root away from `map`', () => {
    let state = initState({ a: 1 });
    state = reducer(state, {
      type: 'setType',
      nodeId: state.tree.rootId,
      newType: 'string',
    });
    expect(state.tree.nodes[state.tree.rootId].type).toBe('map');
  });

  it('setKey changes a map-child key', () => {
    let state = initState({ name: 'Alice' });
    const name = findChild(state, 'name');
    state = reducer(state, { type: 'setKey', nodeId: name.id, key: 'displayName' });
    expect(state.tree.nodes[name.id].key).toBe('displayName');
  });

  it('setKey to a duplicate flags both siblings', () => {
    let state = initState({ a: 1, b: 2 });
    const b = findChild(state, 'b');
    state = reducer(state, { type: 'setKey', nodeId: b.id, key: 'a' });
    expect(state.errorCount).toBeGreaterThanOrEqual(2);
  });

  it('addMapEntry appends a new child', () => {
    let state = initState({ a: 1 });
    state = reducer(state, {
      type: 'addMapEntry',
      parentId: state.tree.rootId,
      key: 'b',
      childType: 'number',
    });
    expect(state.tree.childIds[state.tree.rootId].length).toBe(2);
    const b = findChild(state, 'b');
    expect(b.type).toBe('number');
    expect(b.value).toBe(0);
  });

  it('addArrayEntry appends a new array child', () => {
    let state = initState({ tags: ['a'] });
    const tags = findChild(state, 'tags');
    state = reducer(state, {
      type: 'addArrayEntry',
      parentId: tags.id,
      childType: 'string',
    });
    expect(state.tree.childIds[tags.id].length).toBe(2);
  });

  it('addArrayEntry rejects nested arrays', () => {
    let state = initState({ tags: ['a'] });
    const tags = findChild(state, 'tags');
    const before = state.tree.childIds[tags.id].length;
    state = reducer(state, {
      type: 'addArrayEntry',
      parentId: tags.id,
      childType: 'array',
    });
    expect(state.tree.childIds[tags.id].length).toBe(before);
  });

  it('remove drops a leaf', () => {
    let state = initState({ a: 1, b: 2 });
    const b = findChild(state, 'b');
    state = reducer(state, { type: 'remove', nodeId: b.id });
    expect(state.tree.childIds[state.tree.rootId].length).toBe(1);
    expect(state.tree.nodes[b.id]).toBeUndefined();
  });

  it('remove drops an entire subtree', () => {
    let state = initState({ addr: { city: 'SF', zip: '94110' } });
    const addr = findChild(state, 'addr');
    const cityId = state.tree.childIds[addr.id][0];
    state = reducer(state, { type: 'remove', nodeId: addr.id });
    expect(state.tree.nodes[addr.id]).toBeUndefined();
    expect(state.tree.nodes[cityId]).toBeUndefined();
  });

  it('remove refuses to drop the root', () => {
    let state = initState({ a: 1 });
    state = reducer(state, { type: 'remove', nodeId: state.tree.rootId });
    expect(state.tree.nodes[state.tree.rootId]).toBeDefined();
  });

  it('reset restores the initial tree', () => {
    let state = initState({ name: 'Alice' });
    const name = findChild(state, 'name');
    state = reducer(state, { type: 'setValue', nodeId: name.id, value: 'Bob' });
    state = reducer(state, { type: 'reset' });
    expect(findChild(state, 'name').value).toBe('Alice');
    expect(state.tree).toBe(state.initial);
  });

  it('round-trip: setValue then serialize matches expected output', () => {
    let state = initState({ name: 'Alice', score: 1 });
    const score = findChild(state, 'score');
    state = reducer(state, { type: 'setValue', nodeId: score.id, value: 99 });
    expect(treeToData(state.tree)).toEqual({ name: 'Alice', score: 99 });
  });

  it('touch marks a single node touched without changing its error/value', () => {
    let state = initState({ a: 1 });
    const a = findChild(state, 'a');
    expect(a.touched).toBeUndefined();
    state = reducer(state, { type: 'touch', nodeId: a.id });
    expect(findChild(state, 'a').touched).toBe(true);
    expect(findChild(state, 'a').value).toBe(1);
  });

  it('touch is a no-op (same state) when the node is already touched', () => {
    let state = initState({ a: 1 });
    const a = findChild(state, 'a');
    state = reducer(state, { type: 'touch', nodeId: a.id });
    const afterFirstTouch = state;
    state = reducer(state, { type: 'touch', nodeId: a.id });
    expect(state).toBe(afterFirstTouch);
  });

  it('touchAll marks every node touched in one dispatch', () => {
    let state = initState({ a: 1, addr: { city: 'SF' } });
    state = reducer(state, { type: 'touchAll' });
    for (const node of Object.values(state.tree.nodes)) {
      expect(node.touched).toBe(true);
    }
  });

  it('a freshly-added empty map entry has a required-key error but starts untouched', () => {
    let state = initState({});
    state = reducer(state, {
      type: 'addMapEntry',
      parentId: state.tree.rootId,
      key: '',
      childType: 'string',
    });
    const newId = state.tree.childIds[state.tree.rootId][0];
    const node = state.tree.nodes[newId];
    expect(node.error).toBe('Field name is required');
    expect(node.touched).toBeUndefined();
    // errorCount reflects the error immediately (Save must stay disabled)
    // even though nothing displays it yet — that's a rendering decision,
    // not a validity decision.
    expect(state.errorCount).toBeGreaterThan(0);
  });

  it('round-trip: full flow load → edit → add → remove → serialize', () => {
    let state = initState({ name: 'Alice', tags: ['a', 'b'] });

    const name = findChild(state, 'name');
    state = reducer(state, { type: 'setValue', nodeId: name.id, value: 'Bob' });

    const tags = findChild(state, 'tags');
    state = reducer(state, {
      type: 'addArrayEntry',
      parentId: tags.id,
      childType: 'string',
    });
    const newChildId =
      state.tree.childIds[tags.id][state.tree.childIds[tags.id].length - 1];
    state = reducer(state, { type: 'setValue', nodeId: newChildId, value: 'c' });

    state = reducer(state, {
      type: 'addMapEntry',
      parentId: state.tree.rootId,
      key: 'score',
      childType: 'number',
    });
    const score = findChild(state, 'score');
    state = reducer(state, { type: 'setValue', nodeId: score.id, value: 42 });

    const firstTag = state.tree.childIds[tags.id][0];
    state = reducer(state, { type: 'remove', nodeId: firstTag });

    expect(treeToData(state.tree)).toEqual({
      name: 'Bob',
      tags: ['b', 'c'],
      score: 42,
    });
    expect(state.errorCount).toBe(0);
  });
});
