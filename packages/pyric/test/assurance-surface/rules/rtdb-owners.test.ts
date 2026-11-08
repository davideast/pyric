import { describe, expect, test } from 'bun:test';
import { rtdbOwnerConditions } from '../../../src/assurance-surface/rules/rtdb-owners.js';
import type { OwnerCondition } from '../../../src/assurance-surface/rules/types.js';

function briefItem(c: OwnerCondition): Record<string, unknown> {
  const item: Record<string, unknown> = {
    path: c.path,
    ops: c.ops,
    kind: c.kind,
    field: c.field,
    relation: c.relation,
    required: c.required,
  };
  if (c.varIndex !== undefined) item.varIndex = c.varIndex;
  if (c.location !== undefined) item.location = c.location;
  return item;
}

const brief = (rules: unknown) => rtdbOwnerConditions(rules, 'database.rules.json').map(briefItem);

describe('rtdbOwnerConditions', () => {
  test('a path variable compared to auth.uid, at the depth it is written', () => {
    expect(
      brief({ rules: { tokens: { $uid: { '.read': 'auth.uid == $uid', $device: { '.write': 'auth != null && auth.uid === $uid' } } } } }),
    ).toEqual([
      { path: 'tokens/$uid', ops: ['read'], kind: 'pathVar', field: '$uid', relation: 'equals', required: true, varIndex: 1 },
      { path: 'tokens/$uid/$device', ops: ['write'], kind: 'pathVar', field: '$uid', relation: 'equals', required: true, varIndex: 1 },
    ]);
  });

  test('stored and incoming fields, including a parent-relative field, with absolute locations', () => {
    const out = brief({
      rules: {
        rooms: {
          $room: {
            msgs: {
              $id: {
                '.write': "(!data.exists() || data.child('author').val() == auth.uid) && newData.child('meta/by').val() === auth.uid",
                '.validate': "data.parent().child('speaker/uid').val() == auth.uid",
              },
            },
          },
        },
      },
    });
    expect(out).toEqual([
      { path: 'rooms/$room/msgs/$id', ops: ['write'], kind: 'storedField', field: 'author', relation: 'equals', required: false, location: 'rooms/$room/msgs/$id/author' },
      { path: 'rooms/$room/msgs/$id', ops: ['write'], kind: 'incomingField', field: 'meta/by', relation: 'equals', required: true, location: 'rooms/$room/msgs/$id/meta/by' },
      { path: 'rooms/$room/msgs/$id', ops: ['validate'], kind: 'storedField', field: '../speaker/uid', relation: 'equals', required: true, location: 'rooms/$room/msgs/speaker/uid' },
    ]);
  });

  test('a membership lookup keyed by auth.uid, and a prefix check on a key', () => {
    const out = brief({
      rules: {
        rooms: {
          $room: {
            '.read': "root.child('rooms').child($room).child('members').child(auth.uid).exists()",
            signals: { $from: { '.write': '$from.beginsWith(auth.uid + ":")' } },
          },
        },
      },
    });
    expect(out).toEqual([
      { path: 'rooms/$room', ops: ['read'], kind: 'lookup', field: 'rooms/$room/members/{auth.uid}', relation: 'exists', required: true, location: 'rooms/$room/members/{auth.uid}' },
      { path: 'rooms/$room/signals/$from', ops: ['write'], kind: 'pathVar', field: '$from', relation: 'prefix', required: true, varIndex: 3 },
    ]);
  });

  test('negated lookups and inequalities do not emit positive owner conditions', () => {
    const out = brief({
      rules: {
        rooms: {
          $room: {
            posts: {
              $postId: {
                '.write':
                  "!root.child('rooms').child($room).child('banned').child(auth.uid).exists() && " +
                  "root.child('rooms').child($room).child('suspended').child(auth.uid).exists() == false && " +
                  "root.child('rooms').child($room).child('muted').child(auth.uid).exists() != true && " +
                  "!(auth.uid == data.child('reviewer').val()) && " +
                  "auth.uid != newData.child('approver').val() && " +
                  "!!root.child('rooms').child($room).child('members').child(auth.uid).exists() && " +
                  "newData.child('author').val() == auth.uid",
              },
            },
          },
        },
      },
    });
    expect(out).toEqual([
      { path: 'rooms/$room/posts/$postId', ops: ['write'], kind: 'lookup', field: 'rooms/$room/members/{auth.uid}', relation: 'exists', required: true, location: 'rooms/$room/members/{auth.uid}' },
      { path: 'rooms/$room/posts/$postId', ops: ['write'], kind: 'incomingField', field: 'author', relation: 'equals', required: true, location: 'rooms/$room/posts/$postId/author' },
    ]);
  });

  test('a rule with no tie to auth.uid yields nothing; an unparsable expression is skipped', () => {
    expect(brief({ rules: { presence: { '.write': 'auth != null' }, broken: { '.write': 'auth.uid ==' } } })).toEqual([]);
  });
});
