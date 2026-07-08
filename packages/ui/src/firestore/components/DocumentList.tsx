import type { ReactNode } from 'react';
import type { DocumentReference, QueryDocumentSnapshot } from 'pyric/firestore';
import { VirtualList } from '../../primitives/VirtualList.js';

/**
 * Both backends carry `.ref` on snapshots at runtime, but the
 * `pyric/firestore` modular interface omits it. Pull it through
 * a structural cast — safe because the property is guaranteed by
 * the underlying SDKs.
 */
function snapshotRef(snap: QueryDocumentSnapshot): DocumentReference {
  return (snap as unknown as { ref: DocumentReference }).ref;
}

export interface DocumentListProps {
  documents: QueryDocumentSnapshot[];
  isLoading?: boolean;
  error?: Error;
  hasMore?: boolean;
  onSelect?: (ref: DocumentReference) => void;
  /** Fired when the user requests another page. Wire to the hook's
   *  `loadMore`. The component will not render a Load More button
   *  when this is undefined. */
  onLoadMore?: () => void;
  /**
   * Optional renderer for the row label. Default renders the doc id.
   * Override to show a field value alongside, an icon, etc.
   */
  renderLabel?: (doc: QueryDocumentSnapshot) => ReactNode;
  /**
   * Optional per-row action(s), rendered as a SIBLING of the row's
   * select button inside the entry (not nested in it — so the action
   * carries its own click handling without an invalid button-in-button).
   * Used for row-level affordances like delete.
   */
  renderRowAction?: (doc: QueryDocumentSnapshot) => ReactNode;
  emptyState?: ReactNode;
  className?: string;
  /**
   * Above this row count, the list switches to virtualization via
   * `<VirtualList>`. Default 100. Set to `Infinity` to disable
   * (e.g. when measuring layout shifts is more important than
   * scroll perf).
   */
  virtualizeThreshold?: number;
  /**
   * Estimated row height when virtualizing. Default 36 — matches
   * a single-line text button at 13px font + ~10px padding. Pass
   * a function for variable sizing (TanStack measures the actual
   * height via ResizeObserver after the first paint anyway).
   */
  rowHeight?: number | ((index: number) => number);
  /**
   * Pixel height the virtualized scroll container fills. Only
   * applies when `documents.length > virtualizeThreshold`. Default
   * `'60vh'` — consumers usually constrain via their layout.
   */
  virtualizedHeight?: number | string;
}

/**
 * Headless document list. Below `virtualizeThreshold`, renders a
 * plain `<ul>`; above it, switches to TanStack-Virtual via
 * `<VirtualList>` so 10k-doc collections don't bloat the DOM.
 *
 * The hook owns pagination state; this component just renders. The
 * Load More button only renders when `hasMore` is true AND
 * `onLoadMore` is provided. Consumers wanting infinite scroll
 * trigger `onLoadMore` from a sentinel `IntersectionObserver` in
 * their own code — the component doesn't bake that policy in.
 */
export function DocumentList({
  documents,
  isLoading,
  error,
  hasMore,
  onSelect,
  onLoadMore,
  renderLabel,
  renderRowAction,
  emptyState,
  className,
  virtualizeThreshold = 100,
  rowHeight = 36,
  virtualizedHeight = '60vh',
}: DocumentListProps) {
  if (error) {
    return (
      <div
        className={className}
        data-pyric-ui="document-list"
        data-pyric-error=""
        role="alert"
      >
        {error.message}
      </div>
    );
  }
  if (isLoading && documents.length === 0) {
    return (
      <div
        className={className}
        data-pyric-ui="document-list"
        data-pyric-loading=""
      />
    );
  }
  if (documents.length === 0) {
    return (
      <div className={className} data-pyric-ui="document-list" data-pyric-empty="">
        {emptyState}
      </div>
    );
  }

  const virtualized = documents.length > virtualizeThreshold;

  return (
    <div
      className={className}
      data-pyric-ui="document-list"
      data-pyric-virtualized={virtualized ? '' : undefined}
    >
      {virtualized ? (
        <VirtualList
          items={documents}
          estimateSize={rowHeight}
          height={virtualizedHeight}
          getItemKey={(doc) => snapshotRef(doc).path}
          renderItem={(doc) => (
            <div
              data-pyric-document-entry
              data-pyric-document-id={doc.id}
            >
              <button
                type="button"
                onClick={() => onSelect?.(snapshotRef(doc))}
                data-pyric-document-select
              >
                {renderLabel ? renderLabel(doc) : doc.id}
              </button>
              {renderRowAction ? (
                <span data-pyric-document-action>{renderRowAction(doc)}</span>
              ) : null}
            </div>
          )}
        />
      ) : (
        <ul data-pyric-document-list-items>
          {documents.map((doc) => {
            const ref = snapshotRef(doc);
            return (
              <li
                key={ref.path}
                data-pyric-document-entry
                data-pyric-document-id={doc.id}
              >
                <button
                  type="button"
                  onClick={() => onSelect?.(ref)}
                  data-pyric-document-select
                >
                  {renderLabel ? renderLabel(doc) : doc.id}
                </button>
                {renderRowAction ? (
                  <span data-pyric-document-action>{renderRowAction(doc)}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && onLoadMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          data-pyric-load-more
          disabled={isLoading}
        >
          Load more
        </button>
      ) : null}
    </div>
  );
}
