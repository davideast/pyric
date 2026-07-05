import type { ReactNode } from 'react';
import type { FirebaseStorage } from 'pyric/storage';
import { useConfirm } from '../../primitives/useConfirm.js';
import { useToast } from '../../primitives/Toast.js';
import type { StorageSelectionEntry } from '../hooks/useStorageSelection.js';
import type { UseStorageRulesGateResult } from '../hooks/useStorageRulesGate.js';
import {
  useStorageDelete,
  type StorageDeleteOutcome,
  type StorageRecursiveDeleteImpl,
  type UseStorageDeleteOptions,
} from '../hooks/useStorageDelete.js';

export interface DeleteSelectionWithConfirmProps {
  /** The package's single Storage handle prop. */
  storage: FirebaseStorage | null | undefined;
  /** What to delete — `useStorageSelection().selected` (or any
   *  `{kind, fullPath}` rows). Folders delete recursively. */
  entries: StorageSelectionEntry[];
  /** Folder-walk impl override (default: the `listAll`-driven one). */
  impl?: StorageRecursiveDeleteImpl;
  /** Optimistic seam from `useStorageList`. */
  list?: UseStorageDeleteOptions['list'];
  /**
   * Rules-aware affordance — pass `useStorageRulesGate(storage)`.
   * When ANY selected entry's DELETE verdict denies, the trigger
   * disables with the reason (default trigger: `data-pyric-denied` +
   * `data-pyric-denied-reason` + `title`; `renderTrigger` receives
   * `deniedReason`). For folder entries the verdict evaluates the
   * folder path itself — an approximation of the recursive walk
   * (descendants matched by `{allPaths=**}` rules share the verdict).
   * On prod handles verdicts are advisory; the server stays
   * authoritative either way.
   */
  gate?: Pick<UseStorageRulesGateResult, 'verdictFor'>;
  /** Confirm-dialog title. Default derives from the entry count. */
  title?: string;
  /** Confirm-dialog body. Default lists the selected paths. */
  body?: ReactNode;
  confirmLabel?: string;
  /** Fired after a run with NO failures (e.g. clear the selection +
   *  refresh the list). */
  onDeleted?: (outcome: StorageDeleteOutcome) => void;
  /** Fired after a run with failures (the toast already showed). */
  onFailed?: (outcome: StorageDeleteOutcome) => void;
  /** Render override for the trigger button. */
  renderTrigger?: (props: {
    onClick: () => void;
    isRunning: boolean;
    progress: number;
    disabled: boolean;
    /** Set when the rules gate denied the selection (see `gate`). */
    deniedReason?: string;
  }) => ReactNode;
  /** Class forwarded to the default trigger button. */
  className?: string;
}

/**
 * Bulk delete behind the confirm-dialog primitive, with toasts on
 * outcome — wires `useConfirm` + `useStorageDelete` + `useToast` the
 * way `<DeleteWithConfirm>` wires the Firestore trio. Requires
 * `<ConfirmProvider>` AND `<ToastProvider>` ancestors.
 *
 * Outcome toasts: all-success → one `success` toast with the count;
 * any failure → an `error` toast listing each failed path with its
 * typed `StorageError.code`.
 *
 * The default trigger styles via `[data-pyric-ui="delete-selection"]`
 * (+ `[data-pyric-destructive]`, `[data-pyric-running]`,
 * `[data-pyric-denied]` with the reason on
 * `data-pyric-denied-reason`/`title`); it disables while running,
 * when `entries` is empty, or when the rules `gate` denies the
 * selection.
 */
export function DeleteSelectionWithConfirm({
  storage,
  entries,
  impl,
  list,
  gate,
  title,
  body,
  confirmLabel = 'Delete',
  onDeleted,
  onFailed,
  renderTrigger,
  className,
}: DeleteSelectionWithConfirmProps) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const { deleteEntries, isRunning, progress } = useStorageDelete(storage, {
    impl,
    list,
  });

  // Pre-flight DELETE verdicts over the selection (advisory — the
  // enforcement layer still decides; see the `gate` prop).
  const denied = gate
    ? entries
        .map((e) => ({ entry: e, verdict: gate.verdictFor(e.fullPath) }))
        .filter((d) => !d.verdict.delete)
    : [];
  const deniedReason =
    denied.length === 0
      ? undefined
      : `Delete denied for ${denied[0].entry.fullPath}${
          denied.length > 1 ? ` (+${denied.length - 1} more)` : ''
        }: ${denied[0].verdict.reasons.write.join('; ')}`;

  const disabled =
    isRunning || entries.length === 0 || storage == null || denied.length > 0;

  const handleClick = async () => {
    if (disabled) return;
    const ok = await confirm({
      title:
        title ??
        (entries.length === 1
          ? `Delete ${entries[0].fullPath}?`
          : `Delete ${entries.length} items?`),
      body: body ?? (
        <ul data-pyric-delete-selection-paths>
          {entries.map((e) => (
            <li key={e.fullPath} data-pyric-entry-kind={e.kind}>
              {e.fullPath}
              {e.kind === 'folder' ? '/' : ''}
            </li>
          ))}
        </ul>
      ),
      destructive: true,
      confirmLabel,
    });
    if (!ok) return;

    const outcome = await deleteEntries(entries);
    if (outcome.failed.length === 0) {
      toast({
        title: `Deleted ${outcome.deleted.length} ${
          outcome.deleted.length === 1 ? 'item' : 'items'
        }`,
        kind: 'success',
      });
      onDeleted?.(outcome);
    } else {
      toast({
        title: `Delete failed for ${outcome.failed.length} of ${entries.length}`,
        kind: 'error',
        body: (
          <ul data-pyric-delete-selection-failures>
            {outcome.failed.map((f) => (
              <li key={f.fullPath}>
                {f.fullPath}:{' '}
                {(f.error as { code?: string }).code ?? f.error.message}
              </li>
            ))}
          </ul>
        ),
      });
      onFailed?.(outcome);
    }
  };

  if (renderTrigger) {
    return (
      <>
        {renderTrigger({
          onClick: handleClick,
          isRunning,
          progress,
          disabled,
          deniedReason,
        })}
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={className}
      disabled={disabled}
      title={deniedReason}
      data-pyric-ui="delete-selection"
      data-pyric-destructive=""
      data-pyric-running={isRunning ? '' : undefined}
      data-pyric-denied={deniedReason ? '' : undefined}
      data-pyric-denied-reason={deniedReason}
    >
      {isRunning ? `Deleting… (${progress})` : confirmLabel}
    </button>
  );
}
