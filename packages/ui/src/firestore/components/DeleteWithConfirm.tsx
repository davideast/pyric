import { type ReactNode } from 'react';
import type {
  CollectionReference,
  DocumentReference,
} from 'pyric/firestore';
import { useConfirm } from '../../primitives/useConfirm.js';
import {
  useRecursiveDelete,
  type RecursiveDeleteImpl,
} from '../hooks/useRecursiveDelete.js';

export interface DeleteWithConfirmProps {
  /** The doc / collection to delete. */
  target: DocumentReference | CollectionReference;
  /** Implementation that walks the tree + deletes. Consumer-supplied.
   *  Sandbox-backed apps usually wire `pyric/sandbox` introspection;
   *  production apps usually call a Cloud Function. */
  impl: RecursiveDeleteImpl;
  /** Confirm-dialog title. Defaults to a sensible derivation from
   *  the target's path. */
  title?: string;
  /** Confirm-dialog body. */
  body?: ReactNode;
  /** Label on the destructive button. */
  confirmLabel?: string;
  /** Fired after the delete iterator finishes successfully. */
  onDeleted?: () => void;
  /** Optional render override for the trigger button. */
  renderTrigger?: (props: {
    onClick: () => void;
    isRunning: boolean;
    progress: number;
  }) => ReactNode;
  /** Class forwarded to the default trigger button. */
  className?: string;
}

/**
 * Composition that wires `useConfirm` + `useRecursiveDelete`. Requires
 * a `<ConfirmProvider>` ancestor.
 *
 * The default trigger renders a plain `<button>` carrying the
 * destructive intent (the consumer styles via `[data-pyric-destructive]`).
 * Consumers wanting different chrome pass `renderTrigger`.
 */
export function DeleteWithConfirm({
  target,
  impl,
  title,
  body,
  confirmLabel = 'Delete',
  onDeleted,
  renderTrigger,
  className,
}: DeleteWithConfirmProps) {
  const confirm = useConfirm();
  const { delete: runDelete, isRunning, progress, error } = useRecursiveDelete(impl);

  const handleClick = async () => {
    const ok = await confirm({
      title: title ?? `Delete ${target.path}?`,
      body,
      destructive: true,
      confirmLabel,
    });
    if (!ok) return;
    await runDelete(target);
    if (!error) onDeleted?.();
  };

  if (renderTrigger) {
    return <>{renderTrigger({ onClick: handleClick, isRunning, progress })}</>;
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={className}
      disabled={isRunning}
      data-pyric-ui="delete-with-confirm"
      data-pyric-destructive=""
      data-pyric-running={isRunning ? '' : undefined}
    >
      {isRunning ? `Deleting… (${progress})` : confirmLabel}
    </button>
  );
}
