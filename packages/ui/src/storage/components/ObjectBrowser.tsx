import type { ReactNode } from 'react';
import type { StorageReference } from 'pyric/storage';
import { VirtualList } from '../../primitives/VirtualList.js';
import { useContainerSize } from '../../primitives/hooks/useContainerSize.js';
import type {
  StorageListEntry,
  StorageListStatus,
} from '../hooks/useStorageList.js';
import type { UseStorageRulesGateResult } from '../hooks/useStorageRulesGate.js';

export interface ObjectBrowserProps {
  /** The folders-first row model from `useStorageList`. */
  entries: StorageListEntry[];
  /** Drives the loading state (`'loading'` with no rows yet) and the
   *  idle short-circuit. Default `'success'` for static usage. */
  status?: StorageListStatus;
  /** Renders a `role="alert"` container with the message. Pair with
   *  the hook's typed `StorageError` for code-driven copy. */
  error?: Error;
  /** Folder row click — fired with the prefix's `fullPath`. Wire to
   *  `usePathState.enter` (or `setPath`). */
  onNavigate?: (path: string) => void;
  /** Object row click — fired with the object's reference. */
  onSelect?: (ref: StorageReference) => void;
  /** Marks the matching object row `data-pyric-selected` +
   *  `aria-selected`. */
  selectedPath?: string;
  /**
   * Rules-aware affordances — pass `useStorageRulesGate(storage)`.
   * Rows whose READ verdict denies are stamped `data-pyric-denied`
   * (with the evaluator's reason trace on
   * `data-pyric-denied-reason`). A denied folder row would throw
   * `storage/unauthorized` on `listAll`; the stamp warns BEFORE the
   * click. Rows stay clickable — the affordance is advisory and the
   * sandbox enforcement layer remains authoritative.
   */
  gate?: Pick<UseStorageRulesGateResult, 'verdictFor'>;
  /**
   * Row-label slot. Default renders the entry name. The row button,
   * its click wiring, and the `data-*` states stay with the
   * component — the slot only owns the label content.
   */
  renderEntry?: (entry: StorageListEntry) => ReactNode;
  emptyState?: ReactNode;
  className?: string;
  /**
   * Above this row count, the list switches to virtualization via
   * `<VirtualList>` — `listAll` has no pagination, so a big prefix
   * arrives as one flat result and virtualization is the only
   * defense. Default 100 (same as `<DocumentList>`). `Infinity`
   * disables.
   */
  virtualizeThreshold?: number;
  /** Estimated row height when virtualizing. Default 36. */
  rowHeight?: number | ((index: number) => number);
  /** Scroll-container height when virtualized. Default `'60vh'`. */
  virtualizedHeight?: number | string;
}

/**
 * Headless storage browser shell — renders `useStorageList`'s merged
 * folder/object rows. Folder rows navigate (`onNavigate` with the
 * prefix path), object rows select (`onSelect` with the ref). Below
 * `virtualizeThreshold` renders a plain `<ul>`; above it, composes
 * the package's `<VirtualList>`.
 *
 * Ships no visual styling. Consumers style via:
 * - `[data-pyric-ui="object-browser"]` — the root (stamps `data-size`)
 * - `…[data-pyric-loading]` / `[data-pyric-empty]` / `[data-pyric-error]`
 * - `…[data-pyric-virtualized]` — virtualized mode
 * - `[data-pyric-object-browser-items]` — the `<ul>` in plain mode
 * - `[data-pyric-storage-entry]` — each row
 * - `[data-pyric-storage-entry][data-pyric-entry-kind="folder"|"object"]`
 * - `[data-pyric-storage-entry][data-pyric-entry-path="docs/a.txt"]`
 * - `[data-pyric-storage-entry][data-pyric-denied]` — read-denied row
 *   (rules gate; reason on `data-pyric-denied-reason`)
 * - `[data-pyric-entry-select]` — the row button
 * - `[data-pyric-entry-select][data-pyric-selected]` — the selected object
 */
export function ObjectBrowser({
  entries,
  status = 'success',
  error,
  onNavigate,
  onSelect,
  selectedPath,
  gate,
  renderEntry,
  emptyState,
  className,
  virtualizeThreshold = 100,
  rowHeight = 36,
  virtualizedHeight = '60vh',
}: ObjectBrowserProps) {
  const { ref: rootRef, size } = useContainerSize<HTMLDivElement>();

  if (error) {
    return (
      <div
        className={className}
        data-pyric-ui="object-browser"
        data-pyric-error=""
        role="alert"
      >
        {error.message}
      </div>
    );
  }
  if ((status === 'loading' || status === 'idle') && entries.length === 0) {
    return (
      <div
        className={className}
        data-pyric-ui="object-browser"
        data-pyric-loading={status === 'loading' ? '' : undefined}
        data-pyric-idle={status === 'idle' ? '' : undefined}
      />
    );
  }
  if (entries.length === 0) {
    return (
      <div className={className} data-pyric-ui="object-browser" data-pyric-empty="">
        {emptyState}
      </div>
    );
  }

  // Pre-flight read verdict per row (advisory — see the `gate` prop).
  const denialFor = (
    entry: StorageListEntry,
  ): { denied: true; reason: string } | { denied: false; reason?: undefined } => {
    if (!gate) return { denied: false };
    const verdict = gate.verdictFor(entry.fullPath);
    return verdict.read
      ? { denied: false }
      : { denied: true, reason: verdict.reasons.read.join('; ') };
  };

  const renderRow = (entry: StorageListEntry) => {
    const selected = entry.kind === 'object' && entry.fullPath === selectedPath;
    return (
      <button
        type="button"
        onClick={() =>
          entry.kind === 'folder'
            ? onNavigate?.(entry.fullPath)
            : onSelect?.(entry.ref)
        }
        data-pyric-entry-select
        data-pyric-selected={selected ? '' : undefined}
        aria-selected={selected || undefined}
      >
        {renderEntry ? renderEntry(entry) : entry.name}
      </button>
    );
  };

  const virtualized = entries.length > virtualizeThreshold;

  return (
    <div
      ref={rootRef}
      className={className}
      data-pyric-ui="object-browser"
      data-size={size}
      data-pyric-virtualized={virtualized ? '' : undefined}
    >
      {virtualized ? (
        <VirtualList
          items={entries}
          estimateSize={rowHeight}
          height={virtualizedHeight}
          getItemKey={(entry) => `${entry.kind}:${entry.fullPath}`}
          renderItem={(entry) => {
            const denial = denialFor(entry);
            return (
              <div
                data-pyric-storage-entry
                data-pyric-entry-kind={entry.kind}
                data-pyric-entry-path={entry.fullPath}
                data-pyric-denied={denial.denied ? '' : undefined}
                data-pyric-denied-reason={denial.reason}
              >
                {renderRow(entry)}
              </div>
            );
          }}
        />
      ) : (
        <ul data-pyric-object-browser-items>
          {entries.map((entry) => {
            const denial = denialFor(entry);
            return (
              <li
                key={`${entry.kind}:${entry.fullPath}`}
                data-pyric-storage-entry
                data-pyric-entry-kind={entry.kind}
                data-pyric-entry-path={entry.fullPath}
                data-pyric-denied={denial.denied ? '' : undefined}
                data-pyric-denied-reason={denial.reason}
              >
                {renderRow(entry)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
