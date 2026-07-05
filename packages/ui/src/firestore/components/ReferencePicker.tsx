import { useState } from 'react';
import type {
  CollectionReference,
  DocumentReference,
  Firestore,
} from 'pyric/firestore';
import {
  useReferencePicker,
  type BrowseLocation,
} from '../hooks/useReferencePicker.js';

export interface ReferencePickerProps {
  firestore: Firestore;
  /** Initial path text. */
  initialPath?: string;
  /**
   * Lister for subcollections. Required — see
   * `useReferencePicker` docs for the rationale.
   */
  listCollections: (
    firestore: Firestore,
    parent: DocumentReference | null,
  ) => Promise<CollectionReference[]>;
  /** Fired when the user commits a picked reference (browse pick OR
   *  a valid manually-typed path with the Commit button). */
  onPick?: (ref: DocumentReference) => void;
  /** Forwarded to the root. */
  className?: string;
  /** Label for the path text input. Default 'Document path'. */
  pathLabel?: string;
}

/**
 * Visible reference picker — text input + browseable panel.
 *
 * Two ways to commit a reference:
 *
 *   1. Type a path, then click Commit (enabled only when the path
 *      parses to a valid `DocumentReference`).
 *   2. Drill into a collection in the panel and click a document
 *      row.
 *
 * Either path fires `onPick(ref)`. Headless — emits structural
 * `data-pyric-*` for styling.
 */
export function ReferencePicker({
  firestore,
  initialPath,
  listCollections,
  onPick,
  className,
  pathLabel = 'Document path',
}: ReferencePickerProps) {
  const picker = useReferencePicker({ firestore, listCollections, initialPath });
  const [browseOpen, setBrowseOpen] = useState(false);

  return (
    <div className={className} data-pyric-ui="reference-picker">
      <label data-pyric-reference-path-label>
        {pathLabel}
        <input
          type="text"
          value={picker.pathInput}
          onChange={(e) => picker.setPathInput(e.target.value)}
          placeholder="users/alice"
          data-pyric-reference-path-input
          aria-invalid={picker.error ? 'true' : undefined}
        />
      </label>
      {picker.error ? (
        <span data-pyric-error-message>{picker.error}</span>
      ) : null}
      <div data-pyric-reference-actions>
        <button
          type="button"
          data-pyric-reference-browse-toggle
          aria-expanded={browseOpen}
          onClick={() => setBrowseOpen((o) => !o)}
        >
          {browseOpen ? 'Close browser' : 'Browse'}
        </button>
        <button
          type="button"
          data-pyric-reference-commit
          disabled={!picker.reference}
          onClick={() => {
            if (picker.reference) onPick?.(picker.reference);
          }}
        >
          Commit
        </button>
      </div>
      {browseOpen ? (
        <BrowsePanel
          browseLocation={picker.browseLocation}
          canDrillBack={picker.canDrillBack}
          collections={picker.collections}
          documents={picker.documents}
          isLoading={picker.isLoading}
          drillIntoCollection={picker.drillIntoCollection}
          drillIntoDocument={picker.drillIntoDocument}
          drillBack={picker.drillBack}
          onPick={(ref) => {
            picker.pick(ref);
            onPick?.(ref);
          }}
        />
      ) : null}
    </div>
  );
}

interface BrowsePanelProps {
  browseLocation: BrowseLocation;
  canDrillBack: boolean;
  collections: CollectionReference[];
  documents: ReturnType<typeof useReferencePicker>['documents'];
  isLoading: boolean;
  drillIntoCollection: (ref: CollectionReference) => void;
  drillIntoDocument: (ref: DocumentReference) => void;
  drillBack: () => void;
  onPick: (ref: DocumentReference) => void;
}

function BrowsePanel({
  browseLocation,
  canDrillBack,
  collections,
  documents,
  isLoading,
  drillIntoCollection,
  drillIntoDocument,
  drillBack,
  onPick,
}: BrowsePanelProps) {
  const here = describeLocation(browseLocation);
  return (
    <div
      data-pyric-ui="reference-browse-panel"
      data-pyric-loading={isLoading ? '' : undefined}
    >
      <div data-pyric-browse-header>
        <button
          type="button"
          data-pyric-browse-back
          onClick={drillBack}
          disabled={!canDrillBack}
          aria-label="Back"
        >
          ←
        </button>
        <span data-pyric-browse-location>{here}</span>
      </div>
      {browseLocation.kind === 'root' || browseLocation.kind === 'document' ? (
        <ul data-pyric-browse-collections>
          {collections.map((c) => (
            <li
              key={c.path}
              data-pyric-browse-entry
              data-pyric-entry-kind="collection"
              data-pyric-collection-id={c.id}
            >
              <button
                type="button"
                onClick={() => drillIntoCollection(c)}
                data-pyric-browse-select
              >
                {c.id}/
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul data-pyric-browse-documents>
          {documents.map((d) => {
            const ref = (d as unknown as { ref: DocumentReference }).ref;
            return (
              <li
                key={ref.path}
                data-pyric-browse-entry
                data-pyric-entry-kind="document"
                data-pyric-document-id={d.id}
              >
                <button
                  type="button"
                  onClick={() => onPick(ref)}
                  data-pyric-browse-pick
                >
                  {d.id}
                </button>
                <button
                  type="button"
                  onClick={() => drillIntoDocument(ref)}
                  data-pyric-browse-drill
                  aria-label="Drill into subcollections"
                >
                  →
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function describeLocation(loc: BrowseLocation): string {
  if (loc.kind === 'root') return '/';
  if (loc.kind === 'document') return `/${loc.ref.path}`;
  return `/${loc.ref.path}`;
}
