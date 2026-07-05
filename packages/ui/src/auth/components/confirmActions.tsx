import type { ReactNode } from 'react';
import type { AuthUserRecord } from 'pyric/auth';
import { useConfirm } from '../../primitives/useConfirm.js';

/** Shared trigger contract for the confirm-gated destructive actions. */
interface TriggerProps {
  onClick: () => void;
}

export interface DeleteUserWithConfirmProps {
  user: AuthUserRecord;
  /** Runs after the user confirms. Wire to `useAuthUsers().deleteUser`. */
  onDelete: (uid: string) => void;
  title?: string;
  body?: ReactNode;
  confirmLabel?: string;
  /** Trigger override; default is a plain destructive `<button>`. */
  renderTrigger?: (props: TriggerProps) => ReactNode;
  className?: string;
}

function identifierOf(user: AuthUserRecord): string {
  return user.email ?? user.phoneNumber ?? user.displayName ?? user.uid;
}

/**
 * Confirm-gated single-user delete (the emulator UI's row-menu
 * "Delete user"). Requires a `<ConfirmProvider>` ancestor.
 */
export function DeleteUserWithConfirm({
  user,
  onDelete,
  title = 'Delete user',
  body,
  confirmLabel = 'Delete',
  renderTrigger,
  className,
}: DeleteUserWithConfirmProps) {
  const confirm = useConfirm();
  const handleClick = async () => {
    const ok = await confirm({
      title,
      body: body ?? `This will permanently delete ${identifierOf(user)}.`,
      destructive: true,
      confirmLabel,
    });
    if (ok) onDelete(user.uid);
  };
  if (renderTrigger) return <>{renderTrigger({ onClick: handleClick })}</>;
  return (
    <button
      type="button"
      className={className}
      data-pyric-ui="delete-user"
      data-pyric-destructive
      onClick={handleClick}
    >
      Delete user
    </button>
  );
}

export interface ClearUsersWithConfirmProps {
  /** Runs after the user confirms. Wire to `useAuthUsers().clearUsers`. */
  onClear: () => void;
  /** Current user count, interpolated into the default body. */
  count?: number;
  title?: string;
  body?: ReactNode;
  confirmLabel?: string;
  renderTrigger?: (props: TriggerProps) => ReactNode;
  className?: string;
}

/**
 * Confirm-gated clear-all (the emulator UI's "Clear all data").
 * Requires a `<ConfirmProvider>` ancestor.
 */
export function ClearUsersWithConfirm({
  onClear,
  count,
  title = 'Clear all users',
  body,
  confirmLabel = 'Clear',
  renderTrigger,
  className,
}: ClearUsersWithConfirmProps) {
  const confirm = useConfirm();
  const handleClick = async () => {
    const ok = await confirm({
      title,
      body:
        body ??
        (count != null
          ? `This will permanently delete all ${count} users.`
          : 'This will permanently delete every user.'),
      destructive: true,
      confirmLabel,
    });
    if (ok) onClear();
  };
  if (renderTrigger) return <>{renderTrigger({ onClick: handleClick })}</>;
  return (
    <button
      type="button"
      className={className}
      data-pyric-ui="clear-users"
      data-pyric-destructive
      onClick={handleClick}
    >
      Clear all users
    </button>
  );
}
