/**
 * Live Firestore viewer/editor (F2).
 *
 * Composes the `@pyric/ui/firestore` components into a Firebase-console-style
 * drilling miller-column stack: navigation is a PATH (collection -> document ->
 * subcollection -> document -> ...), each segment is a column, and drilling
 * PUSHES a column rather than swapping a fixed one. A clickable breadcrumb at
 * the top reflects the path and jumps to any level. NOTHING here reimplements
 * field rendering/editing - the library owns it; Studio styles the
 * `data-pyric-*` contract in `firestore.css`. Grids run under the active access
 * mode (App = rules apply / Admin = rules bypass, edit anything).
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  CollectionList,
  DocumentList,
  DocumentPreview,
  DocumentEditor,
  treeToData,
  useFirestoreApi,
  type FirestoreApi,
  type DocumentEditorRootProps,
} from '@pyric/ui/firestore';
import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  QueryDocumentSnapshot,
} from 'pyric/firestore';
import { useDocumentList } from '@pyric/ui/firestore/hooks';
import { useDataNav, parseDocPath, type NavigationPathSegment } from './navigation.js';
import type { StudioDataHandles } from './sandbox.js';
import './firestore.css';

/** The editor state shape `DocumentEditor.Root`'s `onChange` emits. */
type EditorState = Parameters<NonNullable<DocumentEditorRootProps['onChange']>>[0];

/**
 * Build a `CollectionReference` for a (possibly nested) collection path,
 * hierarchically from the parent document ref - so a subcollection is
 * `collection(doc(fs, parentDocPath), id)`, never a multi-segment
 * `collection(fs, "a/b/c")` (which both backends don't reliably accept).
 */
function collectionAtPath(api: FirestoreApi, firestore: Firestore, collPath: string): CollectionReference {
  const segs = collPath.split('/');
  if (segs.length === 1) return api.collection(firestore, collPath);
  const collId = segs[segs.length - 1] as string;
  const parentDocPath = segs.slice(0, -1).join('/');
  return api.collection(api.doc(firestore, parentDocPath), collId);
}

export interface FirestorePaneProps {
  handles: StudioDataHandles;
  /** Known uids (passed by DataFeature; reserved for a future uid->user
   *  field-editor override). Unused by the library-composed body. */
  knownUids?: ReadonlySet<string>;
}

export function LiveFirestorePane({ handles }: FirestorePaneProps) {
  const { target, navigate } = useDataNav();
  // Data views are always admin (M3): the rules-bypass handle, no lens.
  const firestore = handles.adminFirestore;
  // The modular fns: in-process by default, the SharedWorker client bundle in
  // served mode (injected by DataFeature's FirestoreApiProvider).
  const api = useFirestoreApi();

  // The drill path is URL-derived: for the firestore view it IS `target.path`
  // (see navigation.tsx). Drilling writes the hash via `navigate`, so the path
  // is deep-linkable, reload-persistent, and follows browser back/forward.
  const path = useMemo<NavigationPathSegment[]>(
    () => (target?.view === 'firestore' ? target.path : []),
    [target],
  );
  const setPath = useCallback(
    (next: NavigationPathSegment[] | ((p: NavigationPathSegment[]) => NavigationPathSegment[])) => {
      const resolved = typeof next === 'function' ? next(path) : next;
      navigate({ view: 'firestore', path: resolved });
    },
    [navigate, path],
  );

  // Selecting in the column at depth `i` replaces everything deeper.
  const selectAt = (i: number, seg: NavigationPathSegment) =>
    setPath((p) => [...p.slice(0, i + 1), seg]);

  // The full column stack: root collections + one column per path segment.
  const columns = [
    <CollectionColumn
      key="__root__"
      api={api}
      firestore={firestore}
      collectionIds={handles.listRootCollections()}
      onSelect={(id) => setPath([{ kind: 'collection', id, path: id }])}
    />,
    ...path.map((seg, i) =>
      seg.kind === 'collection' ? (
        <DocumentColumn
          key={seg.path}
          api={api}
          firestore={firestore}
          collectionPath={seg.path}
          selectedId={path[i + 1]?.id ?? null}
          onSelect={(ref) => selectAt(i, { kind: 'document', id: ref.id, path: ref.path })}
        />
      ) : (
        <DocumentDetailColumn
          key={seg.path}
          api={api}
          firestore={firestore}
          handles={handles}
          docPath={seg.path}
          onOpenSubcollection={(coll) => selectAt(i, { kind: 'collection', id: coll.id, path: coll.path })}
          onReferenceClick={(r) => navigate({ view: 'firestore', path: parseDocPath(r.path) })}
        />
      ),
    ),
  ];

  // Firebase-console behavior: always a 3-panel window that SHIFTS as you drill
  // (show the deepest 3 levels), not an ever-growing strip. The breadcrumb keeps
  // the full path for jumping back. Stable keys mean only the new column mounts
  // (and slides in via CSS); the retained two don't remount.
  const SLOTS = 3;
  const realVisible = columns.length <= SLOTS ? columns : columns.slice(-SLOTS);
  // Zero-state: always render a stable SLOTS-wide frame. Pad the trailing slots
  // with placeholder columns so the layout is present from load instead of
  // growing in as you drill. The first empty slot hints what to pick next.
  const nextHint =
    path.length === 0
      ? 'Select a collection'
      : path[path.length - 1]?.kind === 'collection'
        ? 'Select a document'
        : null;
  const visible = [
    ...realVisible,
    ...Array.from({ length: Math.max(0, SLOTS - realVisible.length) }, (_, k) => (
      <EmptyColumn key={`__empty_${k}__`} hint={k === 0 ? nextHint : null} />
    )),
  ];

  return (
    <div data-pyric-ui="fs-browser" data-fs-depth={path.length}>
      <Breadcrumb path={path} onHome={() => setPath([])} onJump={(i) => setPath((p) => p.slice(0, i + 1))} />
      <div className="fs-columns">{visible}</div>
    </div>
  );
}

/** Clickable path bar: home > collection > doc > … (the tail is the current level). */
function Breadcrumb({
  path,
  onHome,
  onJump,
}: {
  path: NavigationPathSegment[];
  onHome: () => void;
  onJump: (index: number) => void;
}) {
  return (
    <nav data-pyric-ui="fs-breadcrumb" aria-label="Firestore path">
      <button type="button" className="fs-crumb" onClick={onHome}>
        home
      </button>
      {path.map((seg, i) => (
        <Fragment key={seg.path}>
          <span className="fs-crumb-sep" aria-hidden>
            ›
          </span>
          {i === path.length - 1 ? (
            <span className="fs-crumb fs-crumb--current">{seg.id}</span>
          ) : (
            <button type="button" className="fs-crumb" onClick={() => onJump(i)}>
              {seg.id}
            </button>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

/** Zero-state placeholder column — keeps the miller-column frame a stable width
 *  before the user has drilled that far. The first empty slot carries a hint
 *  ("Select a collection" / "Select a document"); deeper empties are blank. */
function EmptyColumn({ hint }: { hint: string | null }) {
  return (
    <section
      data-pyric-ui="fs-empty-col"
      className="fs-pane fs-col fs-col--empty"
      aria-hidden={hint ? undefined : true}
    >
      {hint ? <p className="fs-empty">{hint}</p> : null}
    </section>
  );
}

/** Root collections column. */
function CollectionColumn({
  api,
  firestore,
  collectionIds,
  onSelect,
}: {
  api: FirestoreApi;
  firestore: Firestore;
  collectionIds: string[];
  onSelect: (id: string) => void;
}) {
  const collections = useMemo(
    () => collectionIds.map((id) => api.collection(firestore, id)),
    [api, firestore, collectionIds],
  );
  return (
    <section data-pyric-ui="fs-collections" className="fs-pane fs-col">
      <div className="fs-phead">Collections</div>
      <CollectionList
        collections={collections}
        onSelect={(coll) => onSelect(coll.id)}
        emptyState={<p className="fs-empty">No collections yet. App or agent writes show up here.</p>}
      />
    </section>
  );
}

/** Documents in one collection (root or subcollection, by path). */
function DocumentColumn({
  api,
  firestore,
  collectionPath,
  selectedId,
  onSelect,
}: {
  api: FirestoreApi;
  firestore: Firestore;
  collectionPath: string;
  selectedId: string | null;
  onSelect: (ref: DocumentReference) => void;
}) {
  const collection = useMemo(
    () => collectionAtPath(api, firestore, collectionPath),
    [api, firestore, collectionPath],
  );
  const { documents, isLoading, error, hasMore, loadMore, deleteDocument } = useDocumentList({ collection });
  const collId = collectionPath.split('/').pop() ?? collectionPath;
  // Per-row delete: plain click arms an inline confirm; shift-click deletes
  // immediately (rapid bulk delete). Only one row arms at a time.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<Error | null>(null);
  const doDelete = useCallback(
    async (r: DocumentReference) => {
      setDeleteError(null);
      try {
        await deleteDocument(r);
        setConfirmingId((id) => (id === r.id ? null : id));
      } catch (e) {
        setDeleteError(e instanceof Error ? e : new Error(String(e)));
      }
    },
    [deleteDocument],
  );
  return (
    <section data-pyric-ui="fs-documents" className="fs-pane fs-col">
      <div className="fs-phead">
        <span className="fs-phead-title">{collId}</span>
      </div>
      <DocumentList
        documents={documents}
        isLoading={isLoading}
        error={error}
        hasMore={hasMore}
        onLoadMore={loadMore}
        onSelect={onSelect}
        renderLabel={(snap: QueryDocumentSnapshot) => {
          const ref = (snap as unknown as { ref: DocumentReference }).ref;
          return (
            <span data-pyric-selected={selectedId === ref.id ? '' : undefined} style={{ display: 'contents' }}>
              {snap.id}
            </span>
          );
        }}
        renderRowAction={(snap: QueryDocumentSnapshot) => {
          const r = (snap as unknown as { ref: DocumentReference }).ref;
          if (confirmingId === r.id) {
            return (
              <span className="fs-doc-del-confirm">
                <button
                  type="button"
                  className="fs-doc-del-yes"
                  title="Confirm delete"
                  aria-label={`Confirm delete ${r.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void doDelete(r);
                  }}
                >
                  ✓
                </button>
                <button
                  type="button"
                  className="fs-doc-del-no"
                  title="Cancel"
                  aria-label="Cancel delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingId(null);
                  }}
                >
                  ✕
                </button>
              </span>
            );
          }
          return (
            <button
              type="button"
              className="fs-doc-del"
              title="Delete document (shift-click to skip confirmation)"
              aria-label={`Delete ${r.id} (shift-click to skip confirmation)`}
              onClick={(e) => {
                e.stopPropagation();
                if (e.shiftKey) void doDelete(r);
                else setConfirmingId(r.id);
              }}
            >
              ×
            </button>
          );
        }}
        emptyState={<p className="fs-empty">No documents.</p>}
      />
      {deleteError ? <p className="fs-empty fs-doc-del-err">{deleteError.message}</p> : null}
    </section>
  );
}

/** One document's detail: fields (read) or the typed editor, plus its
 *  subcollections (drillable). The breadcrumb carries the path, so no
 *  in-column path label. */
function DocumentDetailColumn({
  api,
  firestore,
  handles,
  docPath,
  onOpenSubcollection,
  onReferenceClick,
}: {
  api: FirestoreApi;
  firestore: Firestore;
  handles: StudioDataHandles;
  docPath: string;
  onOpenSubcollection: (coll: CollectionReference) => void;
  onReferenceClick: (ref: DocumentReference) => void;
}) {
  const ref = useMemo(() => api.doc(firestore, docPath), [api, firestore, docPath]);
  const [snapshot, setSnapshot] = useState<DocumentSnapshot | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEditing(false);
    api
      .getDoc(ref)
      .then((snap) => {
        if (!cancelled) setSnapshot(snap);
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, ref, tick]);

  const data = useMemo(() => (snapshot?.data() as Record<string, unknown>) ?? {}, [snapshot]);
  const listSubcollections = useCallback(
    async (_fs: Firestore, parent: DocumentReference) => {
      const ids = await handles.listSubcollections(parent.path);
      return ids.map((id) => api.collection(parent, id));
    },
    [handles, api],
  );
  const docId = docPath.split('/').pop() ?? docPath;

  return (
    <section data-pyric-ui="fs-document" className="fs-pane fs-col doc">
      <div className="fs-phead">
        <span className="fs-phead-title">{docId}</span>
        {!editing ? (
          <button type="button" onClick={() => setEditing(true)} className="fs-docact">
            Edit
          </button>
        ) : null}
      </div>

      {editing ? (
        <DocumentEditPanel
          key={docPath}
          initial={data}
          onCancel={() => setEditing(false)}
          onSave={async (next) => {
            setSaveError(null);
            try {
              await api.setDoc(ref, next);
              setEditing(false);
              setTick((n) => n + 1);
            } catch (e) {
              setSaveError(e instanceof Error ? e : new Error(String(e)));
            }
          }}
          error={saveError}
        />
      ) : (
        <DocumentPreview
          snapshot={snapshot}
          className="fs-docbody"
          documentRef={ref}
          firestore={firestore}
          listSubcollections={listSubcollections}
          onReferenceClick={onReferenceClick}
          onSubcollectionClick={onOpenSubcollection}
          emptyState={<p className="fs-empty">Empty document.</p>}
        />
      )}
    </section>
  );
}

/**
 * The document editor: the library's `<DocumentEditor>` (typed per-field editing
 * via the `fieldEditors` registry) over the admin handle. No raw JSON: each
 * field is edited by its type. Save is enabled only when the tree is valid +
 * dirty; `treeToData` recovers the document to write.
 */
function DocumentEditPanel({
  initial,
  onSave,
  onCancel,
  error,
}: {
  initial: Record<string, unknown>;
  onSave: (next: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
  error: Error | null;
}) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const canSave = !!editor && editor.isValid && editor.isDirty;

  return (
    <div className="fs-editor" data-pyric-ui="fs-editor">
      <DocumentEditor.Root initial={initial} onChange={setEditor}>
        <DocumentEditor.Fields />
      </DocumentEditor.Root>

      {error ? <p className="fs-editor__err">{error.message}</p> : null}

      <div className="fs-editor__actions">
        <button
          type="button"
          className="fs-editor__save"
          disabled={!canSave}
          onClick={() => editor && void onSave(treeToData(editor.tree))}
        >
          Save
        </button>
        <button type="button" className="fs-editor__cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
