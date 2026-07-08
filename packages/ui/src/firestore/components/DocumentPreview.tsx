import { useMemo, useState, type ReactNode } from 'react';
import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
} from 'pyric/firestore';
import { FieldRenderer } from './FieldRenderer.js';
import { inferType } from '../types.js';
import { mergeFieldEditors } from '../fieldEditors/registry.js';
import type { FieldEditorRegistry } from '../fieldEditors/types.js';
import { DisplayContextProvider, type DisplayContextValue } from './context.js';
import { useContainerSize } from '../../primitives/hooks/useContainerSize.js';
import {
  useDocumentSubcollections,
  type ListSubcollections,
} from '../hooks/useDocumentSubcollections.js';

/**
 * `DocumentSnapshot.exists` is a method on the firebase/firestore
 * `QueryDocumentSnapshot` (`.exists()`) and a getter/property on the
 * Admin chainable adapter. `pyric/firestore` unions the two; this
 * helper handles either.
 */
function snapshotExists(snapshot: DocumentSnapshot): boolean {
  const e = (snapshot as { exists: boolean | (() => boolean) }).exists;
  return typeof e === 'function' ? e.call(snapshot) : e;
}

export interface DocumentPreviewProps {
  /** Snapshot from `useFirestoreDoc` or `getDoc`. When `null` /
   *  `undefined`, renders {@link emptyState}. */
  snapshot: DocumentSnapshot | null | undefined;
  /** Override or extend the built-in field editors. Merged on top
   *  of {@link defaultFieldEditors} — only the keys you provide
   *  override. */
  fieldEditors?: FieldEditorRegistry;
  /** Content rendered when the snapshot is missing or
   *  `!exists()`. Defaults to `null` (renders nothing). */
  emptyState?: ReactNode;
  /** Forwarded to the root `<div>`. */
  className?: string;
  /**
   * Fired when a reference field is clicked. When supplied, the
   * reference Display renders as an interactive `<button>` (with
   * `data-pyric-clickable`); when omitted, it stays inert as a
   * `<span>`. Consumers wire navigation here — the library does
   * not depend on a router.
   */
  onReferenceClick?: (ref: DocumentReference) => void;
  /**
   * The document's own reference. Required to surface its
   * subcollections — `DocumentSnapshot` (as typed by `pyric/firestore`)
   * doesn't expose `.ref`, so the consumer threads the ref it already
   * holds from fetching the doc. Without it (or without
   * {@link listSubcollections}) the Subcollections section is omitted.
   */
  documentRef?: DocumentReference | null;
  /**
   * Firestore handle passed to {@link listSubcollections}. Required
   * alongside `documentRef` + `listSubcollections` to surface the
   * Subcollections section (the same explicit-handle shape
   * `ReferencePicker` uses).
   */
  firestore?: Firestore;
  /**
   * Injected lister for the document's subcollections. The modular Web
   * SDK has no client-side `listCollections`; sandbox-backed apps wire
   * `pyric/sandbox`'s in-process listing, production apps pass a known
   * list or a server proxy. Same shape `ReferencePicker` /
   * `useCollectionList` use. Omit to hide the Subcollections section.
   */
  listSubcollections?: ListSubcollections;
  /**
   * Fired when a subcollection's drill affordance is activated. Receives
   * the subcollection's `CollectionReference` (its `.path` is the
   * navigate target). Consumers wire navigation here.
   */
  onSubcollectionClick?: (collection: CollectionReference) => void;
}

/**
 * Read-only renderer for a Firestore document. Iterates top-level
 * fields in lexicographic order; each field dispatches through the
 * field-editor registry on its inferred type.
 *
 * Headless — no shipped CSS. Consumers style via `className` on the
 * root and `[data-pyric-field-type]` / `[data-pyric-field-path]`
 * attribute selectors on the per-field nodes.
 *
 * Editing arrives in M3 (`<DocumentEditor>`). M2 only displays.
 */
export function DocumentPreview({
  snapshot,
  fieldEditors,
  emptyState = null,
  className,
  onReferenceClick,
  documentRef,
  firestore,
  listSubcollections,
  onSubcollectionClick,
}: DocumentPreviewProps) {
  const displayCtx = useMemo<DisplayContextValue>(
    () => ({ onReferenceClick }),
    [onReferenceClick],
  );
  const { ref: rootRef, size } = useContainerSize<HTMLDivElement>();

  if (!snapshot || !snapshotExists(snapshot)) {
    return <>{emptyState}</>;
  }
  const data = snapshot.data() ?? {};
  const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
  const registry = mergeFieldEditors(fieldEditors);

  return (
    <DisplayContextProvider value={displayCtx}>
      <div
        ref={rootRef}
        className={className}
        data-pyric-ui="document-preview"
        data-doc-id={snapshot.id}
        data-size={size}
      >
        {entries.map(([key, value]) => (
          <FieldEntry key={key} fieldKey={key} value={value} registry={registry} />
        ))}
        {firestore && documentRef && listSubcollections ? (
          <SubcollectionsSection
            firestore={firestore}
            documentRef={documentRef}
            listSubcollections={listSubcollections}
            onSubcollectionClick={onSubcollectionClick}
          />
        ) : null}
      </div>
    </DisplayContextProvider>
  );
}

/**
 * One top-level document field. A scalar renders `key  value` in the field grid;
 * a map/array renders a disclosure (chevron + key) that collapses its value, so
 * top-level containers toggle just like the nested tree does. A chevron gutter
 * sits on scalars too (empty) so every key aligns.
 */
function FieldEntry({
  fieldKey,
  value,
  registry,
}: {
  fieldKey: string;
  value: unknown;
  registry: FieldEditorRegistry;
}) {
  const type = inferType(value);
  const nested = type === 'map' || type === 'array';
  const [expanded, setExpanded] = useState(true);

  if (!nested) {
    return (
      <div data-pyric-field-entry data-field-name={fieldKey}>
        <span data-pyric-field-keycell>
          <span data-pyric-tree-chevron data-pyric-tree-chevron-empty aria-hidden="true" />
          <span data-pyric-field-key>{fieldKey}</span>
        </span>
        <FieldRenderer value={value} path={fieldKey} fieldEditors={registry} />
      </div>
    );
  }

  return (
    <div data-pyric-field-entry data-field-name={fieldKey} data-pyric-field-nested>
      <button
        type="button"
        data-pyric-field-keycell
        data-pyric-field-toggle
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span data-pyric-tree-chevron aria-hidden="true">
          ›
        </span>
        <span data-pyric-field-key>{fieldKey}</span>
      </button>
      {expanded ? <FieldRenderer value={value} path={fieldKey} fieldEditors={registry} /> : null}
    </div>
  );
}

interface SubcollectionsSectionProps {
  firestore: Firestore;
  documentRef: DocumentReference;
  listSubcollections: ListSubcollections;
  onSubcollectionClick?: (collection: CollectionReference) => void;
}

/**
 * The "Subcollections" section under a document's fields. Lists the
 * document's OWN subcollections (name + a drill affordance), mirroring
 * the `c-data` mock. Reuses the injected-lister pattern; emits the
 * subcollection ref through {@link onSubcollectionClick} for navigation.
 *
 * Renders nothing once loaded if the document has no subcollections —
 * an empty section is noise. While loading it carries
 * `data-pyric-loading` so consumers can show a placeholder.
 */
function SubcollectionsSection({
  firestore,
  documentRef,
  listSubcollections,
  onSubcollectionClick,
}: SubcollectionsSectionProps) {
  const { subcollections, isLoading } = useDocumentSubcollections({
    firestore,
    documentRef,
    listSubcollections,
  });

  if (!isLoading && subcollections.length === 0) return null;

  return (
    <section
      data-pyric-ui="subcollections"
      data-pyric-loading={isLoading ? '' : undefined}
    >
      <div data-pyric-subcollections-group>Subcollections</div>
      <ul data-pyric-subcollections-list>
        {subcollections.map((coll) => (
          <li
            key={coll.path}
            data-pyric-subcollection
            data-pyric-collection-id={coll.id}
            data-pyric-collection-path={coll.path}
          >
            {onSubcollectionClick ? (
              <button
                type="button"
                data-pyric-subcollection-row
                data-pyric-clickable
                onClick={() => onSubcollectionClick(coll)}
                aria-label={`Open subcollection ${coll.id}`}
              >
                <span data-pyric-subcollection-key>{coll.id}</span>
                <span data-pyric-subcollection-type>subcollection</span>
                <span data-pyric-subcollection-drill aria-hidden="true">
                  ›
                </span>
              </button>
            ) : (
              <div data-pyric-subcollection-row>
                <span data-pyric-subcollection-key>{coll.id}</span>
                <span data-pyric-subcollection-type>subcollection</span>
                <span data-pyric-subcollection-drill aria-hidden="true">
                  ›
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
