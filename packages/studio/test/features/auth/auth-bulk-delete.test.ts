import { describe, expect, it } from 'bun:test';
import type { AuthUserRecord } from 'pyric/auth';
import {
  deleteAuthUsers,
  retainVisibleUserIds,
} from '../../../src/features/auth/auth-bulk-delete.js';

const user = (uid: string) => ({ uid }) as AuthUserRecord;

describe('Auth filtered bulk deletion', () => {
  it('select-all retains only ids present in the filtered user list', () => {
    const previouslySelected = new Set(['alice', 'amy', 'bob']);
    const filteredUsers = [user('alice'), user('amy')];

    expect([...retainVisibleUserIds(previouslySelected, filteredUsers)]).toEqual([
      'alice',
      'amy',
    ]);
  });

  it('deletes only the filtered users supplied by the selection', async () => {
    const deleted: string[] = [];
    const filteredUsers = [user('alice'), user('amy')];

    const failed = await deleteAuthUsers(filteredUsers, async (uid) => {
      deleted.push(uid);
    });

    expect(deleted).toEqual(['alice', 'amy']);
    expect(deleted).not.toContain('bob');
    expect(failed).toEqual([]);
  });
});
