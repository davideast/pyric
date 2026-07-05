import type { ReactNode } from 'react';
import type { CollectionReference } from 'pyric/firestore';

export interface CollectionListProps {
  collections: CollectionReference[];
  isLoading?: boolean;
  error?: Error;
  /** Fired when a list item is clicked. Consumer wires navigation. */
  onSelect?: (collection: CollectionReference) => void;
  /** Optional empty-state node. Rendered when `collections.length`
   *  is 0 and the list isn't loading. */
  emptyState?: ReactNode;
  className?: string;
}

/**
 * Headless collection list. Takes a pre-fetched array of references
 * (from `useCollectionList`) plus a select callback. Renders one
 * row per collection with `data-pyric-collection-id` for styling
 * and testing. The library does not own the data fetch — the hook
 * does — so this component is a thin presentational layer.
 */
export function CollectionList({
  collections,
  isLoading,
  error,
  onSelect,
  emptyState,
  className,
}: CollectionListProps) {
  if (error) {
    return (
      <div
        className={className}
        data-pyric-ui="collection-list"
        data-pyric-error=""
        role="alert"
      >
        {error.message}
      </div>
    );
  }
  if (isLoading && collections.length === 0) {
    return (
      <div
        className={className}
        data-pyric-ui="collection-list"
        data-pyric-loading=""
      />
    );
  }
  if (collections.length === 0) {
    return (
      <div className={className} data-pyric-ui="collection-list" data-pyric-empty="">
        {emptyState}
      </div>
    );
  }
  return (
    <ul className={className} data-pyric-ui="collection-list">
      {collections.map((coll) => (
        <li
          key={coll.path}
          data-pyric-collection-entry
          data-pyric-collection-id={coll.id}
        >
          <button
            type="button"
            onClick={() => onSelect?.(coll)}
            data-pyric-collection-select
          >
            {coll.id}
          </button>
        </li>
      ))}
    </ul>
  );
}
