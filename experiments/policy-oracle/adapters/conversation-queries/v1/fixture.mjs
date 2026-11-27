import assert from 'node:assert/strict';

export const family = 'conversation-queries';
export function steps({uids, runId}) {
  const collection = 'conversations';
  const rooms = ['x','y'].map(room => collection + '/' + runId + '-' + room);
  const outsider = 'nonmember-' + runId;
  assert.ok(!Object.values(uids).includes(outsider));
  function write(id, op, actor, room, members) {
    return {id, op, actor, path:rooms[room], data:{memberIds:members.map(member => uids[member])}, watch:rooms};
  }
  function queries(phase) {
    function list(name, actor, op, value) {
      return {id:phase + '-' + name, actor, op:'query', path:collection, watch:rooms,
        filters:op ? [['memberIds', op, value]] : []};
    }
    return [
      ...['a','b','c'].map(actor => list('own-' + actor, actor, 'array-contains', uids[actor])),
      list('peer-b', 'a', 'array-contains', uids.b),
      list('unfiltered', 'a'),
      list('any-a', 'a', 'array-contains-any', [uids.a]),
      list('any-a-d', 'a', 'array-contains-any', [uids.a, outsider]),
    ];
  }
  return [
    write('create-x','set','a',0,['a','b']),
    write('create-y','set','b',1,['b','c']),
    ...queries('before'),
    write('replace-b-with-c','update','a',0,['a','c']),
    ...queries('after'),
  ];
}
