/**
 * Selector bar above the Firestore data viewer when named databases exist or
 * when a `?database=` URL query parameter selects one.
 */
import {
  DEFAULT_FIRESTORE_DATABASE,
  type StudioFirestoreDatabaseStatus,
} from '../../shell/firestore-databases.js';

export interface FirestoreDatabaseBarProps {
  databases: readonly StudioFirestoreDatabaseStatus[];
  selectedDatabase: string | undefined;
  onSelectDatabase: (databaseId: string | undefined) => void;
}

export function FirestoreDatabaseBar({
  databases,
  selectedDatabase,
  onSelectDatabase,
}: FirestoreDatabaseBarProps) {
  const activeId = selectedDatabase ?? DEFAULT_FIRESTORE_DATABASE;
  if (databases.length <= 1 && activeId === DEFAULT_FIRESTORE_DATABASE) {
    return null;
  }

  const knownIds = new Set(databases.map((entry) => entry.id));
  const displayEntries: StudioFirestoreDatabaseStatus[] = [...databases];
  if (!knownIds.has(activeId)) {
    displayEntries.push({
      id: activeId,
      rulesDeployed: false,
      rulesStatusLabel: 'undeclared',
    });
  }
  const activeEntry = displayEntries.find((entry) => entry.id === activeId);

  return (
    <div
      data-pyric-ui="firestore-database-bar"
      className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-sidebar-bg px-3 py-2 text-xs"
    >
      <div
        role="tablist"
        aria-label="Firestore databases"
        className="flex flex-wrap items-center gap-1.5"
      >
        <span className="mr-1 font-semibold uppercase tracking-wider text-slate-gray">
          Database
        </span>
        {displayEntries.map((entry) => {
          const isSelected = entry.id === activeId;
          let nextSelection: string | undefined;
          if (entry.id !== DEFAULT_FIRESTORE_DATABASE) {
            nextSelection = entry.id;
          }
          let stateClasses = 'text-slate-gray hover:bg-content-bg hover:text-soft-white';
          if (isSelected) {
            stateClasses = 'bg-primary/20 font-semibold text-soft-white';
          }
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              data-firestore-database-option={entry.id}
              onClick={() => onSelectDatabase(nextSelection)}
              className={`rounded px-2 py-1 font-mono text-xs transition-colors ${stateClasses}`}
            >
              {entry.id}
            </button>
          );
        })}
      </div>
      {activeEntry ? (
        <span
          data-pyric-ui="firestore-database-rules-status"
          className="font-mono text-[11px] text-slate-gray"
        >
          {activeEntry.id}: {activeEntry.rulesStatusLabel}
        </span>
      ) : null}
    </div>
  );
}
