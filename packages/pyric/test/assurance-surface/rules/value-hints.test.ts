import { describe, expect, test } from 'bun:test';
import { firestoreValueHints, rtdbValueHints } from '../../../src/assurance-surface/rules/value-hints.js';

describe('firestoreValueHints', () => {
  test('extracts positive incoming field literals, inlines helpers, and skips negated equalities', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isOpen() {
      return request.resource.data.status == 'open';
    }
    function validKind(data) {
      return data.kind == 'task' && !(data.role == 'admin');
    }
    match /tickets/{ticketId} {
      allow create: if isOpen()
        && validKind(request.resource.data)
        && !(request.resource.data.tier == 'enterprise')
        && request.resource.data.priority != 99
        && !!(request.resource.data.archived == false);
    }
  }
}`;

    expect(firestoreValueHints(rules)).toEqual([
      { service: 'firestore', path: 'tickets/{ticketId}', field: 'status', value: 'open' },
      { service: 'firestore', path: 'tickets/{ticketId}', field: 'kind', value: 'task' },
      { service: 'firestore', path: 'tickets/{ticketId}', field: 'archived', value: false },
    ]);
  });
});

describe('rtdbValueHints', () => {
  test('extracts positive newData literal comparisons and skips negated comparisons', () => {
    const rules = {
      rules: {
        presence: {
          $uid: {
            '.write': "auth.uid === $uid && !(newData.child('role').val() === 'admin')",
            '.validate': "newData.child('state').val() === 'online' && !!(newData.child('version').val() == 2)",
          },
        },
      },
    };

    expect(rtdbValueHints(rules)).toEqual([
      { service: 'rtdb', path: 'presence/$uid', field: 'state', value: 'online' },
      { service: 'rtdb', path: 'presence/$uid', field: 'version', value: 2 },
    ]);
  });
});
