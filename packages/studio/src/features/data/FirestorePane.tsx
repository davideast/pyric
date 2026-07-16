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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CollectionList,
  DocumentList,
  useFirestoreApi,
  type FirestoreApi,
} from '@pyric/ui/firestore';
import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  QueryDocumentSnapshot,
} from 'pyric/firestore';
import { useDocumentList, useFirestoreDoc } from '@pyric/ui/firestore/hooks';
import { ConfirmProvider, useConfirm, useContainerSize } from '@pyric/ui/primitives';
import { useDataNav, parseDocPath, type NavigationPathSegment } from './navigation.js';
import { PANEL_BREAKPOINTS, panelWindow } from './panelLayout.js';
import type { StudioDataHandles } from './sandbox.js';
import { FirestoreCreateModal, type FirestoreCreateSubmit } from './FirestoreCreateModal.js';
import { FirestoreDocumentTree, SubcollectionsSection } from './FirestoreDocumentTree.js';
import { OverflowMenu } from './OverflowMenu.js';
import { deleteRecursively, makeRecursiveDeleteImpl } from './recursiveDelete.js';
import { confirmDocumentDelete } from './document-delete.js';
import './firestore.css';

/**
 * `DocumentSnapshot.exists` is a method on the firebase/firestore
 * `QueryDocumentSnapshot` (`.exists()`) and a getter/property on the Admin
 * chainable adapter. Same helper `<DocumentPreview>` used internally.
 */
function snapshotExists(snapshot: DocumentSnapshot): boolean {
  const e = (snapshot as { exists: boolean | (() => boolean) }).exists;
  return typeof e === 'function' ? e.call(snapshot) : e;
}

/** CREATE semantics without a create primitive on `FirestoreApi`: probe the
 *  backend with `getDoc`, refuse to overwrite, then `setDoc` (the same probe
 *  `useDocumentList().createDocument` uses — see that hook's decision note). */
async function createDocWithProbe(
  api: FirestoreApi,
  coll: CollectionReference,
  docId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const ref = api.doc(coll, docId);
  const existing = await api.getDoc(ref);
  // `exists` is a method on modular snapshots, a boolean on compat shapes.
  const exists =
    typeof existing.exists === 'function'
      ? existing.exists()
      : Boolean(existing.exists as unknown);
  if (exists) {
    throw new Error(`Document "${docId}" already exists here — choose a different ID.`);
  }
  await api.setDoc(ref, data);
}

/**
 * A "missing" parent doc (no stored fields, real descendants) rendered as a
 * navigable row. Queries correctly exclude these (Firebase parity), so the
 * DocumentColumn synthesizes just enough of a snapshot for `<DocumentList>`'s
 * surface (`.id` + `.ref` + `.data()`) and marks it so the renderers can
 * style it.
 */
function makePhantomRow(ref: DocumentReference): QueryDocumentSnapshot {
  // `data()` must exist: <DocumentList> calls it on every row to feed the
  // update-highlight map. A phantom has no stored document, so `undefined`
  // (a real DocumentSnapshot's miss value) is the honest answer.
  return {
    id: ref.id,
    ref,
    data: () => undefined,
    __pyricPhantom: true,
  } as unknown as QueryDocumentSnapshot;
}

function isPhantomRow(snap: QueryDocumentSnapshot): boolean {
  return (snap as unknown as { __pyricPhantom?: boolean }).__pyricPhantom === true;
}

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

  // "Start a collection" modal (root, or a subcollection under a document).
  // `parentDocPath === null` means a root collection. Document creation in an
  // EXISTING collection is the same modal at the document step, owned by the
  // DocumentColumn (it holds the list hook that refreshes).
  const [collectionTarget, setCollectionTarget] = useState<{ parentDocPath: string | null } | null>(
    null,
  );
  const createCollection = useCallback(
    async ({ collectionId, docId, data }: FirestoreCreateSubmit) => {
      if (!collectionTarget || !collectionId) return;
      const parent = collectionTarget.parentDocPath;
      const coll = parent
        ? api.collection(api.doc(firestore, parent), collectionId)
        : api.collection(firestore, collectionId);
      await createDocWithProbe(api, coll, docId, data);
      const collPath = parent ? `${parent}/${collectionId}` : collectionId;
      // Land inside the new document (also refreshes the root collection list).
      navigate({ view: 'firestore', path: parseDocPath(`${collPath}/${docId}`) });
    },
    [api, firestore, collectionTarget, navigate],
  );

  // The full column stack: root collections + one column per path segment.
  const columns = [
    <CollectionColumn
      key="__root__"
      api={api}
      firestore={firestore}
      collectionIds={handles.listRootCollections()}
      onSelect={(id) => setPath([{ kind: 'collection', id, path: id }])}
      onStartCollection={() => setCollectionTarget({ parentDocPath: null })}
    />,
    ...path.map((seg, i) =>
      seg.kind === 'collection' ? (
        <DocumentColumn
          key={seg.path}
          api={api}
          firestore={firestore}
          handles={handles}
          collectionPath={seg.path}
          selectedId={path[i + 1]?.id ?? null}
          onSelect={(ref) => selectAt(i, { kind: 'document', id: ref.id, path: ref.path })}
          onCollectionDeleted={() => setPath((p) => p.slice(0, i))}
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
          onStartCollection={() => setCollectionTarget({ parentDocPath: seg.path })}
          onDeleted={() => setPath((p) => p.slice(0, i))}
        />
      ),
    ),
  ];

  // Firebase-console behavior: a panel window that SHIFTS as you drill (show
  // the deepest levels), not an ever-growing strip. The breadcrumb keeps the
  // full path for jumping back. Stable keys mean only the new column mounts
  // (and slides in via CSS); retained columns don't remount.
  //
  // HOW MANY panels show is a function of the surface's own width — a
  // CONTAINER measure via `useContainerSize` (house rule: intrinsic, no
  // viewport media queries): 3 at `wide` (unchanged), 2 at `medium`, and at
  // `narrow` ONLY the current level renders full-width with the breadcrumb
  // as the way back up (the Console's phone behavior). Breakpoint rationale
  // lives in `panelLayout.ts`. Hidden panels UNMOUNT (not display:none) so
  // narrow mode doesn't fetch three levels of data to show one.
  const { ref: browserRef, size } = useContainerSize<HTMLDivElement>(PANEL_BREAKPOINTS);
  const { startIndex, visibleCount, emptySlots } = panelWindow(columns.length, size);
  const realVisible = columns.slice(startIndex, startIndex + visibleCount);
  // Zero-state: pad trailing slots with placeholder columns so the frame is
  // present from load instead of growing in as you drill. The first empty
  // slot hints what to pick next. Narrow mode never pads (emptySlots = 0) —
  // the single panel owns the full width.
  const nextHint =
    path.length === 0
      ? 'Select a collection'
      : path[path.length - 1]?.kind === 'collection'
        ? 'Select a document'
        : null;
  const visible = [
    ...realVisible,
    ...Array.from({ length: emptySlots }, (_, k) => (
      <EmptyColumn key={`__empty_${k}__`} hint={k === 0 ? nextHint : null} />
    )),
  ];

  // Focus follows navigation when panels unmount (narrow/medium): after a
  // drill-in or back-out the previously-focused row is often inside a column
  // that no longer exists, dropping focus to <body>. Land it on the deepest
  // visible panel instead so keyboard users continue from the level they
  // navigated to. Wide mode is untouched — nothing unmounts on selection.
  useEffect(() => {
    if (size === 'wide') return;
    const root = browserRef.current;
    if (!root) return;
    const active = document.activeElement;
    if (active && active !== document.body && root.contains(active)) return;
    const deepest = root.querySelector<HTMLElement>('.fs-columns > .fs-col:last-child');
    if (deepest) {
      deepest.tabIndex = -1;
      deepest.focus({ preventScroll: true });
    }
    // Re-run on drill changes only; `size` here just gates the behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path.length, size]);

  return (
    // Field/document/collection delete confirmations (the tree's per-field
    // trash, "Delete document", "Delete collection") all go through
    // `useConfirm()` — scope the provider to this pane rather than mounting
    // it globally, since nothing else in Studio uses it yet.
    <ConfirmProvider>
      <div ref={browserRef} data-pyric-ui="fs-browser" data-fs-depth={path.length} data-size={size}>
        <Breadcrumb path={path} onHome={() => setPath([])} onJump={(i) => setPath((p) => p.slice(0, i + 1))} />
        <div className="fs-columns">{visible}</div>
        {collectionTarget ? (
          <FirestoreCreateModal
            mode="collection"
            parentPath={collectionTarget.parentDocPath ? `/${collectionTarget.parentDocPath}` : '/'}
            onCreate={createCollection}
            onClose={() => setCollectionTarget(null)}
          />
        ) : null}
      </div>
    </ConfirmProvider>
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

/** Root collections column. "+ New" opens the create-collection MODAL
 *  (the emulator-ui composable dialog flow — see `FirestoreCreateModal`);
 *  Firestore collections only exist once they have a document, so creating
 *  one is really "collection id + first document" in one modal. */
function CollectionColumn({
  api,
  firestore,
  collectionIds,
  onSelect,
  onStartCollection,
}: {
  api: FirestoreApi;
  firestore: Firestore;
  collectionIds: string[];
  onSelect: (id: string) => void;
  onStartCollection: () => void;
}) {
  const collections = useMemo(
    () => collectionIds.map((id) => api.collection(firestore, id)),
    [api, firestore, collectionIds],
  );
  return (
    <section data-pyric-ui="fs-collections" className="fs-pane fs-col">
      <div className="fs-phead">
        <span className="fs-phead-title">Collections</span>
        <button type="button" className="fs-add" onClick={onStartCollection}>
          + New
        </button>
      </div>
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
  handles,
  collectionPath,
  selectedId,
  onSelect,
  onCollectionDeleted,
}: {
  api: FirestoreApi;
  firestore: Firestore;
  handles: StudioDataHandles;
  collectionPath: string;
  selectedId: string | null;
  onSelect: (ref: DocumentReference) => void;
  onCollectionDeleted: () => void;
}) {
  const collection = useMemo(
    () => collectionAtPath(api, firestore, collectionPath),
    [api, firestore, collectionPath],
  );
  const {
    documents,
    isLoading,
    error,
    subscriptionGeneration,
    hasMore,
    loadMore,
    createDocument,
  } = useDocumentList({ collection, mode: 'live' });
  // "Missing" parents come from the phantom-inclusive listDocuments seam —
  // the paged getDocs above can't see them (queries match stored docs only).
  // Re-fetched whenever the real page changes so create/delete stays in sync.
  const [phantomIds, setPhantomIds] = useState<readonly string[]>([]);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(handles.listDocuments(collectionPath))
      .then((entries) => {
        if (cancelled) return;
        setPhantomIds(
          entries.filter((e) => e.phantom).map((e) => e.path.split('/').pop() ?? ''),
        );
      })
      .catch(() => {
        if (!cancelled) setPhantomIds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [handles, collectionPath, documents]);
  // Real docs first (the paged order), phantoms after — the same order
  // `LocalState.list` guarantees — deduped by id so a real doc always wins.
  const rows = useMemo(() => {
    const realIds = new Set(documents.map((d) => d.id));
    return [
      ...documents,
      ...phantomIds
        .filter((id) => id.length > 0 && !realIds.has(id))
        .map((id) => makePhantomRow(api.doc(firestore, `${collectionPath}/${id}`))),
    ];
  }, [documents, phantomIds, api, firestore, collectionPath]);
  const collId = collectionPath.split('/').pop() ?? collectionPath;
  const [deleteError, setDeleteError] = useState<Error | null>(null);
  // "+ New" opens the create-document modal (the collection is fixed).
  const [creating, setCreating] = useState(false);

  const confirm = useConfirm();
  const recursiveImpl = useMemo(() => makeRecursiveDeleteImpl(api, handles), [api, handles]);
  const doDelete = useCallback(
    async (ref: DocumentReference) => {
      setDeleteError(null);
      try {
        await confirmDocumentDelete({ confirm, ref, api, recursiveImpl });
      } catch (error) {
        setDeleteError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    [api, confirm, recursiveImpl],
  );
  const onDeleteCollection = useCallback(async () => {
    const ok = await confirm({
      title: `Delete collection "${collId}"?`,
      body: 'This deletes every document in it (and their subcollections).',
      destructive: true,
      confirmLabel: 'Delete collection',
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      await deleteRecursively(recursiveImpl, collection);
      onCollectionDeleted();
    } catch (error) {
      setDeleteError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [confirm, recursiveImpl, collection, collId, onCollectionDeleted]);

  return (
    <section data-pyric-ui="fs-documents" className="fs-pane fs-col">
      <div className="fs-phead">
        <span className="fs-phead-title">{collId}</span>
        <span className="fs-phead-actions">
          <button type="button" className="fs-add" onClick={() => setCreating(true)}>
            + New
          </button>
        </span>
        <OverflowMenu
          items={[
            { label: 'Delete collection', onSelect: () => void onDeleteCollection(), destructive: true },
          ]}
        />
      </div>

      {creating ? (
        <FirestoreCreateModal
          mode="document"
          parentPath={`/${collectionPath}`}
          onCreate={async ({ docId, data }) => {
            // CREATE semantics (the hook's getDoc probe): never overwrite.
            const ref = (await createDocument(docId, data, {
              onExisting: 'fail',
            })) as DocumentReference;
            onSelect(ref);
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
      <DocumentList
        documents={rows}
        isLoading={isLoading}
        error={error}
        updateScope={`${collectionPath}:${subscriptionGeneration}`}
        hasMore={hasMore}
        onLoadMore={loadMore}
        onSelect={onSelect}
        renderLabel={(snap: QueryDocumentSnapshot) => {
          const ref = (snap as unknown as { ref: DocumentReference }).ref;
          return (
            <span data-pyric-selected={selectedId === ref.id ? '' : undefined} style={{ display: 'contents' }}>
              {isPhantomRow(snap) ? (
                <>
                  <span className="fs-doc-phantom">{snap.id}</span>
                  <span className="fs-sub fs-doc-phantom-hint">missing</span>
                </>
              ) : (
                snap.id
              )}
            </span>
          );
        }}
        renderRowAction={(snap: QueryDocumentSnapshot) => {
          // No per-row delete on a phantom: there is no stored doc to delete.
          // Its subtree deletes through the detail column / delete-collection.
          if (isPhantomRow(snap)) return null;
          const r = (snap as unknown as { ref: DocumentReference }).ref;
          return (
            <button
              type="button"
              className="fs-doc-del"
              title="Delete document"
              aria-label={`Delete ${r.id}`}
              onClick={(e) => {
                e.stopPropagation();
                void doDelete(r);
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

/** One document's detail: the Console-style inline-editable field tree, plus
 *  its subcollections (drillable) and a "+ Collection" affordance that spawns
 *  a SUBCOLLECTION through the same create modal (collection step seeded
 *  with this document's path — it's the tree, composable). The breadcrumb
 *  carries the path, so no in-column path label; the tree owns its own
 *  header (doc id + the delete-document / delete-fields overflow). */
function DocumentDetailColumn({
  api,
  firestore,
  handles,
  docPath,
  onOpenSubcollection,
  onReferenceClick,
  onStartCollection,
  onDeleted,
}: {
  api: FirestoreApi;
  firestore: Firestore;
  handles: StudioDataHandles;
  docPath: string;
  onOpenSubcollection: (coll: CollectionReference) => void;
  onReferenceClick: (ref: DocumentReference) => void;
  onStartCollection: () => void;
  onDeleted: () => void;
}) {
  const ref = useMemo(() => api.doc(firestore, docPath), [api, firestore, docPath]);
  const { data: snapshot, error: snapshotError, isLoading } = useFirestoreDoc(ref);

  const listSubcollections = useCallback(
    async (_fs: Firestore, parent: DocumentReference) => {
      const ids = await handles.listSubcollections(parent.path);
      return ids.map((id) => api.collection(parent, id));
    },
    [handles, api],
  );

  const confirm = useConfirm();
  const recursiveImpl = useMemo(() => makeRecursiveDeleteImpl(api, handles), [api, handles]);
  const [deleteError, setDeleteError] = useState<Error | null>(null);
  const onDeleteDocument = useCallback(async () => {
    setDeleteError(null);
    try {
      const deleted = await confirmDocumentDelete({ confirm, ref, api, recursiveImpl });
      if (deleted) onDeleted();
    } catch (error) {
      setDeleteError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [api, confirm, recursiveImpl, ref, onDeleted]);

  const onDeleteDocumentFields = useCallback(async () => {
    await api.setDoc(ref, {});
  }, [api, ref]);

  const exists = snapshot != null && snapshotExists(snapshot);

  return (
    <section data-pyric-ui="fs-document" className="fs-pane fs-col doc">
      {!exists ? (
        <div className="fs-phead">
          <span className="fs-phead-title">{ref.id}</span>
          <span className="fs-phead-actions">
            <button type="button" className="fs-add" onClick={onStartCollection}>
              + Collection
            </button>
          </span>
        </div>
      ) : null}

      {snapshot && exists ? (
        <FirestoreDocumentTree
          key={docPath}
          snapshot={snapshot}
          documentRef={ref}
          firestore={firestore}
          listSubcollections={listSubcollections}
          onReferenceClick={onReferenceClick}
          onSubcollectionClick={onOpenSubcollection}
          onStartCollection={onStartCollection}
          onDeleteDocument={() => void onDeleteDocument()}
          onDeleteDocumentFields={onDeleteDocumentFields}
          onCommit={async (data) => {
            await api.setDoc(ref, data);
          }}
        />
      ) : snapshotError ? (
        <p className="fs-empty fs-doc-del-err">{snapshotError.message}</p>
      ) : isLoading ? (
        <p className="fs-empty">Loading document…</p>
      ) : (
        <>
          {/* Console parity: a missing doc still lists its subcollections —
              that's the only way deep data under a phantom stays reachable. */}
          <p className="fs-empty">This document does not exist.</p>
          <SubcollectionsSection
            firestore={firestore}
            documentRef={ref}
            listSubcollections={listSubcollections}
            onSubcollectionClick={onOpenSubcollection}
          />
        </>
      )}
      {deleteError ? <p className="fs-empty fs-doc-del-err">{deleteError.message}</p> : null}
    </section>
  );
}
