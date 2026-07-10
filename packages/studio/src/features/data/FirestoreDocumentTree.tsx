/**
 * The Firebase-console "panel view" document tree (F2 design review):
 * a Start-collection / Add-field action pair up top, then one row per
 * field with an expandable caret for maps/arrays, a collapsed-preview
 * string, array index chips, hover-reveal (type) + pencil + trash, and
 * inline single-field editing — no more "switch the whole pane into an
 * editor" toggle.
 *
 * Built directly over `@pyric/ui`'s `useDocumentEditor` (the same tree +
 * reducer the whole-document `<DocumentEditor>` uses) rather than the
 * read-only `<DocumentPreview>`: editing here is per-field, so the
 * component needs node ids + mutation, which only the editor tree
 * carries. Every commit re-serializes the FULL tree and calls
 * `onCommit` — Studio's existing `setDoc`-overwrites-the-document
 * pattern (see `DocumentDetailColumn`'s prior `onSave`), not a new
 * partial-update primitive.
 *
 * `@pyric/ui`'s `<DocumentPreview>` / `<TreeEntry>` (the read-only
 * display pair) are untouched — they remain the library's headless,
 * tested read surface for consumers that don't need inline editing.
 * This component owns Studio's presentation of the SAME data via the
 * SAME field-editor registry (`Display`/`Edit` contracts), just wired
 * for row-level interactivity.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentReference, DocumentSnapshot, Firestore } from 'pyric/firestore';
import {
  FieldRenderer,
  firestoreValuesEqual,
  inferType,
  mergeFieldEditors,
  useDocumentEditor,
  validateLeaf,
  asVectorView,
  vectorPreview,
  type FieldEditorRegistry,
  type FieldNode,
  type FieldType,
} from '@pyric/ui/firestore';
import {
  useDocumentSubcollections,
  type ListSubcollections,
} from '@pyric/ui/firestore/hooks';
import {
  useConfirm,
  useUpdateHighlights,
  type UpdateHighlight,
} from '@pyric/ui/primitives';
import type { CollectionReference } from 'pyric/firestore';
import { OverflowMenu } from './OverflowMenu.js';
import {
  containerPreview,
  firestoreDataUpdateEntries,
  firestoreRowIdentity,
  fieldPath,
  rowLabel,
  shouldSkipDeleteConfirm,
  siblingKeyTaken,
} from './firestoreTreeLogic.js';

const LEAF_TYPES: FieldType[] = [
  'string',
  'number',
  'boolean',
  'null',
  'timestamp',
  'geopoint',
  'reference',
  'bytes',
  'vector',
];
const NEW_ENTRY_TYPES: FieldType[] = [...LEAF_TYPES, 'map', 'array'];

export interface FirestoreDocumentTreeProps {
  snapshot: DocumentSnapshot | null;
  documentRef: DocumentReference;
  onCommit: (data: Record<string, unknown>) => Promise<void>;
  onDeleteDocument: () => void;
  onDeleteDocumentFields: () => Promise<void>;
  fieldEditors?: FieldEditorRegistry;
  onReferenceClick?: (ref: DocumentReference) => void;
  onStartCollection?: () => void;
  firestore?: Firestore;
  listSubcollections?: ListSubcollections;
  onSubcollectionClick?: (collection: CollectionReference) => void;
}

export function FirestoreDocumentTree({
  snapshot,
  documentRef,
  onCommit,
  onDeleteDocument,
  onDeleteDocumentFields,
  fieldEditors,
  onReferenceClick,
  onStartCollection,
  firestore,
  listSubcollections,
  onSubcollectionClick,
}: FirestoreDocumentTreeProps) {
  const snapshotData = useMemo(
    () => (snapshot?.data() as Record<string, unknown>) ?? {},
    [snapshot],
  );
  const initial = useMemo(
    () => snapshotData,
    // Deliberately keyed by the doc's identity, not `snapshot` — the
    // consumer remounts this component (`key={docPath}`) on doc change,
    // so `initial` only needs to be computed once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const editor = useDocumentEditor({ initial });
  const replaceEditorData = editor.replaceData;
  const registry = useMemo(() => mergeFieldEditors(fieldEditors), [fieldEditors]);
  const confirm = useConfirm();

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const appliedSnapshotRef = useRef(snapshot);
  const newIdsRef = useRef<Set<string>>(new Set());
  const needsCommitRef = useRef(false);
  const [commitError, setCommitError] = useState<Error | null>(null);
  const updateEntries = useMemo(
    () => firestoreDataUpdateEntries(snapshotData, inferType),
    [snapshotData],
  );
  const updates = useUpdateHighlights({
    scope: documentRef.path,
    entries: updateEntries,
    equals: firestoreValuesEqual,
    ready: editingId === null,
  });

  // Commits fire from an effect (not inline in the handlers) so the
  // reducer's freshest tree is what gets serialized — dispatch is
  // async, `editor.tree` on the next render is not.
  useEffect(() => {
    if (!needsCommitRef.current) return;
    needsCommitRef.current = false;
    setCommitError(null);
    void onCommit(editor.toData()).catch((e) => {
      setCommitError(e instanceof Error ? e : new Error(String(e)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.tree]);

  // Live snapshots replace the editor's clean baseline. While an inline editor
  // is open, keep its draft stable and apply only the newest delivered snapshot
  // after editing closes. Local writes still win because the component's
  // existing commit path writes the full document.
  useEffect(() => {
    if (!snapshot || snapshot === appliedSnapshotRef.current || editingId !== null) return;
    appliedSnapshotRef.current = snapshot;
    newIdsRef.current.clear();
    replaceEditorData((snapshot.data() as Record<string, unknown>) ?? {});
  }, [editingId, replaceEditorData, snapshot]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const [pendingAddParent, setPendingAddParent] = useState<string | null>(null);
  const startAdd = useCallback(
    (parentId: string, kind: 'map' | 'array') => {
      if (kind === 'map') {
        editor.addMapEntry(parentId, '', 'string');
      } else {
        editor.addArrayEntry(parentId, 'string');
      }
      if (parentId !== editor.tree.rootId) {
        const parentIdentity = firestoreRowIdentity(editor.tree, parentId);
        setExpanded((prev) => new Set(prev).add(parentIdentity));
      }
      // The new child always lands at the END of the parent's list —
      // the effect below grabs it once the dispatch's tree lands.
      setPendingAddParent(parentId);
    },
    [editor],
  );

  useEffect(() => {
    if (!pendingAddParent) return;
    const kids = editor.tree.childIds[pendingAddParent] ?? [];
    const lastId = kids[kids.length - 1];
    if (lastId && !editingId) {
      newIdsRef.current.add(lastId);
      setEditingId(lastId);
      setPendingAddParent(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.tree, pendingAddParent]);

  const commitRemove = useCallback(
    (nodeId: string) => {
      editor.remove(nodeId);
      newIdsRef.current.delete(nodeId);
      needsCommitRef.current = true;
      if (editingId === nodeId) setEditingId(null);
    },
    [editor, editingId],
  );

  const handleDelete = useCallback(
    async (node: FieldNode, label: string, e: { shiftKey: boolean }) => {
      if (shouldSkipDeleteConfirm(e)) {
        commitRemove(node.id);
        return;
      }
      const ok = await confirm({
        title: `Delete field "${label}"?`,
        destructive: true,
        confirmLabel: 'Delete',
      });
      if (ok) commitRemove(node.id);
    },
    [confirm, commitRemove],
  );

  const docId = documentRef.id;
  const rootChildren = editor.tree.childIds[editor.tree.rootId] ?? [];

  return (
    <div data-pyric-ui="fs-doctree" className="fs-doctree">
      <div className="fs-doctree__head">
        <span className="fs-doctree__docid">{docId}</span>
        <OverflowMenu
          items={[
            {
              label: 'Delete document fields',
              onSelect: () => {
                void (async () => {
                  const ok = await confirm({
                    title: 'Delete all fields?',
                    body: 'The document itself is kept, empty.',
                    destructive: true,
                    confirmLabel: 'Delete fields',
                  });
                  if (ok) void onDeleteDocumentFields();
                })();
              },
              destructive: true,
            },
            {
              label: 'Delete document',
              onSelect: onDeleteDocument,
              destructive: true,
            },
          ]}
        />
      </div>

      {commitError ? <p className="fs-doctree__err">{commitError.message}</p> : null}

      <ul className="fs-doctree__rows">
        {onStartCollection ? (
          <li className="fs-doctree__action-row">
            <button type="button" className="fs-doctree__action" onClick={onStartCollection}>
              <span aria-hidden="true">+</span> Start collection
            </button>
          </li>
        ) : null}
        <li className="fs-doctree__action-row">
          <button
            type="button"
            className="fs-doctree__action"
            onClick={() => startAdd(editor.tree.rootId, 'map')}
          >
            <span aria-hidden="true">+</span> Add field
          </button>
        </li>

        {rootChildren.map((id) => (
          <Row
            key={id}
            nodeId={id}
            depth={0}
            editor={editor}
            registry={registry}
            expanded={expanded}
            onToggle={toggle}
            editingId={editingId}
            setEditingId={setEditingId}
            newIdsRef={newIdsRef}
            onAdd={startAdd}
            onDelete={handleDelete}
            onCommitNeeded={() => {
              needsCommitRef.current = true;
            }}
            onReferenceClick={onReferenceClick}
            updates={updates}
          />
        ))}
      </ul>

      {firestore && listSubcollections ? (
        <SubcollectionsSection
          firestore={firestore}
          documentRef={documentRef}
          listSubcollections={listSubcollections}
          onSubcollectionClick={onSubcollectionClick}
        />
      ) : null}
    </div>
  );
}

interface RowProps {
  nodeId: string;
  depth: number;
  editor: ReturnType<typeof useDocumentEditor>;
  registry: FieldEditorRegistry;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  newIdsRef: React.MutableRefObject<Set<string>>;
  onAdd: (parentId: string, kind: 'map' | 'array') => void;
  onDelete: (node: FieldNode, label: string, e: { shiftKey: boolean }) => void;
  onCommitNeeded: () => void;
  onReferenceClick?: (ref: DocumentReference) => void;
  updates: ReadonlyMap<string, UpdateHighlight>;
}

function Row({
  nodeId,
  depth,
  editor,
  registry,
  expanded,
  onToggle,
  editingId,
  setEditingId,
  newIdsRef,
  onAdd,
  onDelete,
  onCommitNeeded,
  onReferenceClick,
  updates,
}: RowProps) {
  const { tree } = editor;
  const node = tree.nodes[nodeId];
  if (!node) return null;
  const { label, isArrayChild } = rowLabel(tree, nodeId);
  const isContainer = node.type === 'map' || node.type === 'array';
  const path = fieldPath(tree, nodeId);
  const rowIdentity = firestoreRowIdentity(tree, nodeId);
  const update = updates.get(rowIdentity);
  const isOpen = expanded.has(rowIdentity);
  const isEditing = editingId === nodeId;
  const isNew = newIdsRef.current.has(nodeId);

  if (isEditing) {
    return (
      <li
        className="fs-doctree__row fs-doctree__row--editing"
        data-pyric-doctree-depth={depth}
        style={{ ['--fs-depth' as string]: depth }}
      >
        <EditRow
          node={node}
          isNew={isNew}
          isArrayChild={isArrayChild}
          tree={tree}
          editor={editor}
          registry={registry}
          path={path}
          onCommitNeeded={onCommitNeeded}
          onDone={() => {
            newIdsRef.current.delete(nodeId);
            setEditingId(null);
          }}
          onCancelNew={() => {
            editor.remove(nodeId);
            newIdsRef.current.delete(nodeId);
            setEditingId(null);
          }}
        />
      </li>
    );
  }

  return (
    <li
      className="fs-doctree__row"
      data-pyric-doctree-depth={depth}
      data-pyric-doctree-nested={isContainer ? '' : undefined}
      style={{ ['--fs-depth' as string]: depth }}
    >
      <div
        className="fs-doctree__line"
        data-pyric-update={update?.kind}
        data-pyric-update-cycle={update?.cycle}
      >
        {isContainer ? (
          <button
            type="button"
            className="fs-doctree__caret"
            aria-expanded={isOpen}
            onClick={() => onToggle(rowIdentity)}
          >
            <span aria-hidden="true">{isOpen ? '▼' : '▶'}</span>
          </button>
        ) : (
          <span className="fs-doctree__caret fs-doctree__caret--empty" aria-hidden="true" />
        )}

        {isArrayChild ? (
          <span className="fs-doctree__chip">{label}</span>
        ) : (
          <span className="fs-doctree__key">{label}</span>
        )}

        {isContainer ? (
          !isOpen ? (
            <span className="fs-doctree__preview">
              {containerPreview(tree, nodeId, { asVectorView, vectorPreview })}
            </span>
          ) : null
        ) : (
          <span className="fs-doctree__value">
            <FieldRenderer value={node.value} path={path} fieldEditors={registry} />
          </span>
        )}

        <span className="fs-doctree__hover">
          <span className="fs-doctree__typenote">({node.type})</span>
          {isContainer ? (
            <button
              type="button"
              className="fs-doctree__icon"
              title="Add field"
              aria-label={`Add field to ${label || 'document'}`}
              onClick={() => onAdd(nodeId, node.type === 'array' ? 'array' : 'map')}
            >
              +
            </button>
          ) : (
            <button
              type="button"
              className="fs-doctree__icon"
              title="Edit"
              aria-label={`Edit ${label}`}
              onClick={() => setEditingId(nodeId)}
            >
              ✎
            </button>
          )}
          <button
            type="button"
            className="fs-doctree__icon fs-doctree__icon--danger"
            title="Delete (shift-click to skip confirmation)"
            aria-label={`Delete ${label || 'field'} (shift-click to skip confirmation)`}
            onClick={(e) => void onDelete(node, label, { shiftKey: e.shiftKey })}
          >
            🗑
          </button>
        </span>
      </div>

      {isContainer && isOpen ? (
        <ul className="fs-doctree__children">
          {(tree.childIds[nodeId] ?? []).map((childId) => (
            <Row
              key={childId}
              nodeId={childId}
              depth={depth + 1}
              editor={editor}
              registry={registry}
              expanded={expanded}
              onToggle={onToggle}
              editingId={editingId}
              setEditingId={setEditingId}
              newIdsRef={newIdsRef}
              onAdd={onAdd}
              onDelete={onDelete}
              onCommitNeeded={onCommitNeeded}
              onReferenceClick={onReferenceClick}
              updates={updates}
            />
          ))}
          <li className="fs-doctree__action-row fs-doctree__action-row--nested">
            <button
              type="button"
              className="fs-doctree__action"
              onClick={() => onAdd(nodeId, node.type === 'array' ? 'array' : 'map')}
            >
              <span aria-hidden="true">+</span> {node.type === 'array' ? 'Add item' : 'Add field'}
            </button>
          </li>
        </ul>
      ) : null}
    </li>
  );
}

interface EditRowProps {
  node: FieldNode;
  isNew: boolean;
  isArrayChild: boolean;
  tree: ReturnType<typeof useDocumentEditor>['tree'];
  editor: ReturnType<typeof useDocumentEditor>;
  registry: FieldEditorRegistry;
  path: string;
  onCommitNeeded: () => void;
  onDone: () => void;
  onCancelNew: () => void;
}

/**
 * A single row's inline editor — draft state local to this component,
 * NOT dispatched to the shared tree until Save. That's what makes
 * Cancel on an EXISTING field a true no-op (nothing was ever mutated)
 * instead of needing a value snapshot to restore.
 */
function EditRow({
  node,
  isNew,
  isArrayChild,
  tree,
  editor,
  registry,
  path,
  onCommitNeeded,
  onDone,
  onCancelNew,
}: EditRowProps) {
  const [draftKey, setDraftKey] = useState(node.key ?? '');
  const [draftType, setDraftType] = useState<FieldType>(node.type);
  const [draftValue, setDraftValue] = useState<unknown>(node.value);
  const [touched, setTouched] = useState(false);

  const keyError = !isArrayChild
    ? draftKey === ''
      ? 'Field name is required'
      : siblingKeyTaken(tree, node, draftKey)
        ? 'Field name must be unique'
        : undefined
    : undefined;
  const valueError =
    draftType === 'map' || draftType === 'array' ? undefined : validateLeaf(draftType, draftValue);
  const canSave = !keyError && !valueError;

  const save = () => {
    if (!canSave) {
      setTouched(true);
      return;
    }
    if (!isArrayChild) editor.setKey(node.id, draftKey);
    if (draftType !== node.type) editor.setType(node.id, draftType);
    if (draftType !== 'map' && draftType !== 'array') editor.setValue(node.id, draftValue);
    onCommitNeeded();
    onDone();
  };
  const cancel = () => {
    if (isNew) onCancelNew();
    else onDone();
  };

  const contract = registry[draftType];
  const EditComponent = contract?.Edit;

  const valueEditor =
    draftType !== 'map' && draftType !== 'array' && EditComponent ? (
      <EditComponent
        value={draftValue as never}
        path={path}
        error={touched ? valueError : undefined}
        onChange={(v: unknown) => setDraftValue(v)}
      />
    ) : draftType === 'map' || draftType === 'array' ? (
      <span className="fs-doctree__editnote">
        Saves as an empty {draftType} — add its children afterward.
      </span>
    ) : null;

  const actions = (
    <span className="fs-doctree__editactions">
      <button type="button" className="fs-doctree__editsave" onClick={save} aria-label="Save field">
        ✓
      </button>
      <button
        type="button"
        className="fs-doctree__editcancel"
        onClick={cancel}
        aria-label="Cancel edit"
      >
        ✕
      </button>
    </span>
  );

  // Plain element (not a nested component) so the open <select> keeps its
  // identity — and its focus — across re-renders while the user types.
  const typeSelect = (
    <select
      className="fs-doctree__edittype"
      value={draftType}
      onChange={(e) => {
        const t = e.target.value as FieldType;
        setDraftType(t);
        if (t !== 'map' && t !== 'array' && t !== draftType) {
          setDraftValue(defaultValueForClientType(t));
        }
      }}
      aria-label="Field type"
    >
      {(isNew ? NEW_ENTRY_TYPES : LEAF_TYPES).map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );

  // Explicit stacked LINES (name/type, then value) rather than one
  // flex-wrap row: each line is its own flex row starting at the same
  // content edge, so the name and value inputs share a left x by
  // construction — alignment no longer depends on where the wrap
  // happens to break or on selector precedence between the two inputs.
  return (
    <div
      className="fs-doctree__editrow"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !(e.target as HTMLElement).matches('textarea')) {
          e.preventDefault();
          save();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
    >
      {!isArrayChild ? (
        <div className="fs-doctree__editline">
          <input
            type="text"
            className="fs-doctree__editkey"
            value={draftKey}
            placeholder="Field name"
            autoFocus={isNew}
            onChange={(e) => setDraftKey(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-label="Field name"
            aria-invalid={touched && keyError ? 'true' : undefined}
          />
          {typeSelect}
        </div>
      ) : null}
      <div className="fs-doctree__editline">
        {isArrayChild ? typeSelect : null}
        {valueEditor}
        {actions}
      </div>
      {touched && keyError ? <span className="fs-doctree__editerr">{keyError}</span> : null}
    </div>
  );
}

function defaultValueForClientType(type: FieldType): unknown {
  switch (type) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

interface SubcollectionsSectionProps {
  firestore: Firestore;
  documentRef: DocumentReference;
  listSubcollections: ListSubcollections;
  onSubcollectionClick?: (collection: CollectionReference) => void;
}

/** Same section `<DocumentPreview>` renders, reimplemented against this
 *  component's own tree/row CSS so it sits in the same rhythm as the
 *  fields above it. Exported: `DocumentDetailColumn` also renders it for a
 *  MISSING document (no stored fields, real subcollections), where the tree
 *  itself doesn't mount but the subtree must stay reachable. */
export function SubcollectionsSection({
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
    <section data-pyric-ui="fs-doctree-subcollections" data-pyric-loading={isLoading ? '' : undefined}>
      <div className="fs-doctree__subhead">Subcollections</div>
      <ul className="fs-doctree__sublist">
        {subcollections.map((coll) => (
          <li key={coll.path}>
            {onSubcollectionClick ? (
              <button
                type="button"
                className="fs-doctree__subrow"
                onClick={() => onSubcollectionClick(coll)}
                aria-label={`Open subcollection ${coll.id}`}
              >
                <span>{coll.id}</span>
                <span className="fs-doctree__subtype">subcollection</span>
                <span aria-hidden="true">›</span>
              </button>
            ) : (
              <div className="fs-doctree__subrow">
                <span>{coll.id}</span>
                <span className="fs-doctree__subtype">subcollection</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
