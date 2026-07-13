import { useEffect, useMemo, useState } from 'react';
import type { AuthUserRecord } from 'pyric/auth';
import { useConfirm } from '@pyric/ui/primitives';

export function retainVisibleUserIds(
  selected: ReadonlySet<string>,
  users: AuthUserRecord[],
): Set<string> {
  const visible = new Set(users.map((user) => user.uid));
  return new Set([...selected].filter((uid) => visible.has(uid)));
}

export async function deleteAuthUsers(
  users: AuthUserRecord[],
  onDelete: (uid: string) => Promise<void>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const user of users) {
    try {
      await onDelete(user.uid);
    } catch {
      failed.push(user.uid);
    }
  }
  return failed;
}

/** Selection is always intersected with the users currently rendered. The
 *  Auth surface passes the hook's filtered `users` array, so hidden users can
 *  never survive a filter change into a bulk delete. */
export function useVisibleUserSelection(users: AuthUserRecord[]) {
  const [selectedUids, setSelectedUids] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSelectedUids((previous) => {
      const next = retainVisibleUserIds(previous, users);
      return next.size === previous.size && [...next].every((uid) => previous.has(uid))
        ? previous
        : next;
    });
  }, [users]);

  const selectedUsers = useMemo(
    () => users.filter((user) => selectedUids.has(user.uid)),
    [selectedUids, users],
  );

  return {
    selectedUsers,
    allVisibleSelected: users.length > 0 && selectedUsers.length === users.length,
    isSelected: (uid: string) => selectedUids.has(uid),
    toggle(uid: string) {
      setSelectedUids((previous) => {
        const next = new Set(previous);
        if (next.has(uid)) next.delete(uid);
        else next.add(uid);
        return next;
      });
    },
    selectAll(select: boolean) {
      setSelectedUids(select ? new Set(users.map((user) => user.uid)) : new Set());
    },
    replace(uids: string[]) {
      setSelectedUids(new Set(uids));
    },
    clear() {
      setSelectedUids(new Set());
    },
  };
}

export function DeleteSelectedUsers({
  users,
  filter,
  onDelete,
  onComplete,
}: {
  users: AuthUserRecord[];
  filter: string;
  onDelete: (uid: string) => Promise<void>;
  onComplete: (failedUids: string[]) => void;
}) {
  const confirm = useConfirm();
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const run = async () => {
    const filtered = filter.trim().length > 0;
    const ok = await confirm({
      title: `Delete ${users.length} ${users.length === 1 ? 'user' : 'users'}?`,
      body: filtered
        ? `Only the ${users.length} users shown by the current filter will be deleted.`
        : `This will permanently delete the ${users.length} selected users.`,
      destructive: true,
      confirmLabel: 'Delete users',
    });
    if (!ok) return;

    setIsDeleting(true);
    setDeleteError(null);
    const failed = await deleteAuthUsers(users, onDelete);
    setIsDeleting(false);
    setDeleteError(
      failed.length > 0 ? `Could not delete ${failed.length} selected user(s).` : null,
    );
    onComplete(failed);
  };

  return (
    <>
      <button
        type="button"
        className="studio-selection-delete"
        disabled={isDeleting}
        onClick={() => void run()}
      >
        {isDeleting ? 'Deleting…' : 'Delete'}
      </button>
      {deleteError ? <span className="auth-sub__error">{deleteError}</span> : null}
    </>
  );
}
