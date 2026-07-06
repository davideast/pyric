/**
 * Workspace `Firestore` tab — admin UI for the playground's
 * in-process sandbox, powered entirely by `@pyric/ui`. Proves the
 * library's headless promise: zero @pyric/ui CSS is overridden
 * here; the playground tokens drive the visible styling via the
 * shared `[data-pyric-*]` selectors in `global.css`.
 *
 * Three-level drill-in:
 *
 *   1. Collection list (root). Click a collection → step 2.
 *   2. Document list for the picked collection. Click a doc → step 3.
 *      Back arrow → step 1.
 *   3. Document detail with Preview / Edit toggle. Back arrow → step 2.
 *
 * **Admin mode for writes.** This is an admin panel — Firebase
 * Console-style — so user-initiated writes (create, save edits,
 * delete) go through `sandbox.admin.{setDocument, deleteDocument}`
 * and bypass rules entirely. Going through the rules path is wrong
 * here: the user's own rules might (correctly!) deny anonymous
 * writes, but the admin tab should still let the operator seed and
 * edit data the same way the Firebase Console does. Reads still
 * subscribe through the modular SDK (`useFirestoreCollection` /
 * `useFirestoreDoc`) — they're cheaper to make admin-shaped only
 * if a real rules-denial blocks them.
 *
 * Listings update in real time as the agent or the user's script
 * writes to the sandbox — `useFirestoreCollection` subscribes via
 * `onSnapshot` under the hood. Admin writes call
 * `notifyListenersForPaths` on the live env so subscribers see the
 * change without a poll.
 *
 * Collection enumeration uses the runner's `readState()` because
 * the modular Web-SDK surface can't list collections client-side
 * (same constraint the survey called out for production consumers).
 * The lister is rebuilt on every poll-tick (1s) so newly-written
 * collections appear without a manual refresh.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  collection as collFn,
  getFirestore,
  type CollectionReference,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'pyric/firestore';
import {
  CollectionList,
  DocumentEditor,
  DocumentList,
  DocumentPreview,
  type UseDocumentEditorResult,
} from '@pyric/ui/firestore';
import { useToast } from '@pyric/ui/primitives';
import { getRunner } from '~/lib/sandbox/runner';

/**
 * Admin-mode read hooks. The Firestore tab is a Firebase-Console
 * analog: reads MUST bypass rules so the operator can see every doc
 * regardless of what the user's rules say. The modular SDK hooks
 * (`useFirestoreCollection` / `useFirestoreDoc`) ride on `onSnapshot`,
 * which evaluates rules; an `auth: null` listener gets denied on any
 * collection without a matching block.
 *
 * Implementation: poll `sandbox.admin.{listDocuments, getDocument}`
 * on a 1-second cadence. Cheap (in-memory map walk), no rules eval,
 * works on every collection the operator can see in `readState`.
 * Synthesize `QueryDocumentSnapshot` / `DocumentSnapshot` shapes so
 * the existing `DocumentList` / `DocumentPreview` components consume
 * the result unchanged.
 */
function useAdminCollectionDocs(collPath: string): {
  docs: QueryDocumentSnapshot[];
  isLoading: boolean;
} {
  const [docs, setDocs] = useState<QueryDocumentSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  useEffect(() => {
    const sandbox = getRunner().getSandbox();
    const refresh = (): void => {
      const raw = sandbox.admin.listDocuments(collPath);
      // Phantom entries are synthesized parent docs with no stored
      // data of their own — useful for the discover crawler, noise
      // for an admin user list. Filter them out.
      setDocs(
        raw
          .filter((d) => !d.phantom)
          .map((d) => makeQueryDocSnap(d.path, d.data as Record<string, unknown>)),
      );
      setIsLoading(false);
    };
    refresh();
    const id = window.setInterval(refresh, 1000);
    return () => window.clearInterval(id);
  }, [collPath]);
  return { docs, isLoading };
}

function useAdminDoc(path: string): {
  snapshot: DocumentSnapshot | undefined;
  isLoading: boolean;
} {
  const [snapshot, setSnapshot] = useState<DocumentSnapshot | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  useEffect(() => {
    const sandbox = getRunner().getSandbox();
    const refresh = (): void => {
      const data = sandbox.admin.getDocument(path) as Record<string, unknown> | null;
      setSnapshot(makeDocSnap(path, data));
      setIsLoading(false);
    };
    refresh();
    const id = window.setInterval(refresh, 1000);
    return () => window.clearInterval(id);
  }, [path]);
  return { snapshot, isLoading };
}

function makeQueryDocSnap(
  path: string,
  data: Record<string, unknown>,
): QueryDocumentSnapshot {
  const id = path.split('/').pop() ?? path;
  // Synthesized snapshot. DocumentList consumes `.id`, `.data()`,
  // `.ref`; DocumentPreview also wants `.exists()`. Pre-PR-340 the
  // sandbox returned `.exists` as a property; we render method form
  // to match Firebase's modular SDK shape.
  return {
    id,
    ref: { id, path } as DocumentReference,
    exists: () => true,
    data: () => data,
  } as unknown as QueryDocumentSnapshot;
}

function makeDocSnap(
  path: string,
  data: Record<string, unknown> | null,
): DocumentSnapshot {
  const id = path.split('/').pop() ?? path;
  return {
    id,
    ref: { id, path } as DocumentReference,
    exists: () => data !== null,
    data: () => data ?? undefined,
  } as unknown as DocumentSnapshot;
}

type View =
  | { kind: 'collections' }
  | { kind: 'documents'; coll: CollectionReference }
  | { kind: 'document'; ref: DocumentReference; coll: CollectionReference };

/** Pull root-collection ids out of a flat `path → data` snapshot. */
function rootCollectionIds(state: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  for (const path of Object.keys(state)) {
    const first = path.split('/', 1)[0];
    if (first) seen.add(first);
  }
  return [...seen].sort();
}

export function FirestoreTab() {
  const { toast } = useToast();

  // Modular Firestore handle (used for live subscriptions only —
  // `useFirestoreCollection` / `useFirestoreDoc`). `withAuth(null)`
  // is *not* admin: rules eval still happens, just with `auth ==
  // null`. Subscriptions ride here; *writes* below go through
  // `sandbox.admin.*` to bypass rules entirely.
  const firestore = useMemo<Firestore>(() => {
    return getFirestore(getRunner().getSandbox().withAuth(null));
  }, []);

  // Admin handle for rule-bypassing writes — the RUNNER's wrapper, not
  // `getSandbox().admin`: admin writes emit no sandbox events, so only
  // the wrapper's scheduled flush lands console edits in the
  // per-session persisted blob. Identity-agnostic; one per mount.
  const sandboxAdmin = useMemo(() => getRunner().admin, []);

  const [view, setView] = useState<View>({ kind: 'collections' });
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<UseDocumentEditorResult | null>(null);

  // Poll-tick refreshes the collection list. The sandbox doesn't
  // emit a "collections changed" signal, so we refetch on a 1 s
  // cadence. Cheap because readState() walks an in-memory map.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (view.kind !== 'collections') return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [view.kind]);

  const collections = useMemo<CollectionReference[]>(() => {
    // `tick` is in the dep array so the memo re-runs on each poll.
    void tick;
    const state = getRunner().readState();
    return rootCollectionIds(state).map((id) => collFn(firestore, id));
  }, [firestore, tick]);

  return (
    <div className="flex flex-col h-full bg-content-bg min-h-0">
      <Breadcrumb view={view} onNavigate={setView} />
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 min-h-0">
        {view.kind === 'collections' ? (
          <CollectionsView
            collections={collections}
            onSelect={(coll) => {
              setView({ kind: 'documents', coll });
            }}
            onCreate={async (id, firstId) => {
              try {
                // Admin write — bypasses rules. This tab is the
                // Firebase-Console analog; the operator should be able
                // to seed data even when the user's rules deny
                // anonymous writes.
                sandboxAdmin.setDocument(`${id}/${firstId}`, {});
                toast({ title: `Created ${id}/${firstId}`, kind: 'success' });
                setTick((n) => n + 1);
              } catch (e) {
                toast({
                  title: 'Create failed',
                  body: e instanceof Error ? e.message : String(e),
                  kind: 'error',
                });
              }
            }}
          />
        ) : view.kind === 'documents' ? (
          <DocumentsView
            coll={view.coll}
            onSelect={(ref) => {
              setView({ kind: 'document', ref, coll: view.coll });
              setEditing(false);
            }}
          />
        ) : (
          <DocumentView
            ref={view.ref}
            editing={editing}
            onEdit={() => setEditing(true)}
            onCancelEdit={() => setEditing(false)}
            onSave={async () => {
              if (!editor) return;
              try {
                // Admin write — bypasses rules (see component header).
                sandboxAdmin.setDocument(view.ref.path, editor.toData());
                toast({ title: 'Saved', kind: 'success' });
                setEditing(false);
              } catch (e) {
                toast({
                  title: 'Save failed',
                  body: e instanceof Error ? e.message : String(e),
                  kind: 'error',
                });
              }
            }}
            onDelete={async () => {
              try {
                // Admin delete — bypasses rules.
                sandboxAdmin.deleteDocument(view.ref.path);
                toast({ title: 'Deleted', kind: 'success' });
                setView({ kind: 'documents', coll: view.coll });
              } catch (e) {
                toast({
                  title: 'Delete failed',
                  body: e instanceof Error ? e.message : String(e),
                  kind: 'error',
                });
              }
            }}
            onEditorChange={setEditor}
            editorIsValid={editor?.isValid ?? false}
            editorIsDirty={editor?.isDirty ?? false}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-views

interface CollectionsViewProps {
  collections: CollectionReference[];
  onSelect: (coll: CollectionReference) => void;
  onCreate: (collectionId: string, firstDocId: string) => void;
}

function CollectionsView({ collections, onSelect, onCreate }: CollectionsViewProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [draftCollId, setDraftCollId] = useState('');
  const [draftDocId, setDraftDocId] = useState('');

  return (
    <div className="space-y-3">
      <CollectionList
        collections={collections}
        onSelect={onSelect}
        emptyState={
          <span>
            No collections yet. The sandbox starts empty; the agent or the Run
            button will populate it.
          </span>
        }
      />
      {showCreate ? (
        <div className="rounded-lg border border-[#2a2a35] bg-sidebar-bg p-3 space-y-2">
          <div className="text-[12px] text-slate-gray">Create a new collection</div>
          <input
            type="text"
            placeholder="collection id"
            value={draftCollId}
            onChange={(e) => setDraftCollId(e.target.value)}
            className="w-full bg-content-bg border border-[#2a2a35] rounded px-2 py-1.5 text-soft-white text-[13px] font-mono focus:border-primary focus:outline-none"
          />
          <input
            type="text"
            placeholder="first document id"
            value={draftDocId}
            onChange={(e) => setDraftDocId(e.target.value)}
            className="w-full bg-content-bg border border-[#2a2a35] rounded px-2 py-1.5 text-soft-white text-[13px] font-mono focus:border-primary focus:outline-none"
          />
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                setDraftCollId('');
                setDraftDocId('');
              }}
              className="px-3 py-1 rounded border border-[#2a2a35] text-slate-gray hover:bg-content-bg/60 text-[12px]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!draftCollId.trim() || !draftDocId.trim()}
              onClick={() => {
                onCreate(draftCollId.trim(), draftDocId.trim());
                setShowCreate(false);
                setDraftCollId('');
                setDraftDocId('');
              }}
              className="px-3 py-1 rounded bg-primary text-[#0c0d10] font-medium hover:opacity-90 transition-opacity text-[12px] disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-[#2a2a35] disabled:text-slate-gray"
            >
              Create
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="text-[12px] text-slate-gray hover:text-soft-white px-2 py-1 rounded border border-dashed border-[#2a2a35] hover:border-primary transition-colors"
        >
          + Add collection
        </button>
      )}
    </div>
  );
}

interface DocumentsViewProps {
  coll: CollectionReference;
  onSelect: (ref: DocumentReference) => void;
}

function DocumentsView({ coll, onSelect }: DocumentsViewProps) {
  // Admin read — bypasses rules. See the admin-mode hook block at
  // the top of this file for why we don't use `useFirestoreCollection`
  // here even though it would be the "obvious" choice.
  const { docs, isLoading } = useAdminCollectionDocs(coll.path);
  return (
    <DocumentList
      documents={docs}
      isLoading={isLoading}
      onSelect={onSelect}
      virtualizeThreshold={50}
      renderLabel={(doc) => (
        <span className="flex items-center justify-between gap-3">
          <span className="truncate">{doc.id}</span>
          <span className="text-slate-gray text-[11px] font-mono">
            {Object.keys(doc.data() ?? {}).length} field
            {Object.keys(doc.data() ?? {}).length === 1 ? '' : 's'}
          </span>
        </span>
      )}
      emptyState={<span>Collection is empty.</span>}
    />
  );
}

interface DocumentViewProps {
  ref: DocumentReference;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onDelete: () => void;
  onEditorChange: (state: UseDocumentEditorResult | null) => void;
  editorIsValid: boolean;
  editorIsDirty: boolean;
}

function DocumentView({
  ref,
  editing,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onEditorChange,
  editorIsValid,
  editorIsDirty,
}: DocumentViewProps) {
  // Admin read — bypasses rules. `useAdminDoc` polls
  // `sandbox.admin.getDocument(path)` on a 1s cadence and synthesizes
  // a modular-SDK-shaped `DocumentSnapshot`.
  const { snapshot, isLoading } = useAdminDoc(ref.path);
  const data = snapshot;
  // `DocumentSnapshot.exists` is typed `boolean | (() => boolean)` on
  // @pyric/firestore (admin shape OR modular shape). Our synthesized
  // snap uses the method form; coerce defensively.
  const exists = data
    ? typeof data.exists === 'function'
      ? data.exists()
      : !!data.exists
    : false;

  if (isLoading) {
    return <div className="text-slate-gray text-[13px]">Loading…</div>;
  }
  if (!exists) {
    return <div className="text-slate-gray text-[13px] italic">No such document.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <button
              type="button"
              onClick={onSave}
              disabled={!editorIsValid || !editorIsDirty}
              className="h-7 px-3 rounded text-[12px] font-medium bg-primary text-[#0c0d10] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-[#2a2a35] disabled:text-slate-gray transition-opacity"
            >
              Save
            </button>
            <button
              type="button"
              onClick={onCancelEdit}
              className="h-7 px-3 rounded text-[12px] border border-[#2a2a35] text-slate-gray hover:bg-content-bg/60"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onEdit}
              className="h-7 px-3 rounded text-[12px] font-medium bg-soft-white text-[#1a1a22] hover:bg-soft-white/90"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="h-7 px-3 rounded text-[12px] border border-[#3a2a2a] text-[#f0a0a0] bg-[#3a2a2a]/20 hover:bg-[#3a2a2a]/30"
            >
              Delete
            </button>
          </>
        )}
      </div>

      {editing ? (
        <DocumentEditor.Root initial={data?.data() ?? {}} onChange={onEditorChange}>
          <DocumentEditor.Fields />
        </DocumentEditor.Root>
      ) : (
        <DocumentPreview snapshot={data} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface BreadcrumbProps {
  view: View;
  onNavigate: (view: View) => void;
}

function Breadcrumb({ view, onNavigate }: BreadcrumbProps) {
  // Root anchor renders as a named label ("root") instead of a bare
  // slash so the user has a visible, scannable hit target to get
  // back to the collections list. The leading `/` is decorative only;
  // the actual back-to-root action sits on the labeled button.
  return (
    <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[#2a2a35] text-[12px] font-mono shrink-0">
      <span className="text-slate-gray/60">/</span>
      <button
        type="button"
        onClick={() => onNavigate({ kind: 'collections' })}
        title="Back to all collections"
        className={
          view.kind === 'collections'
            ? 'text-soft-white'
            : 'text-slate-gray hover:text-soft-white underline-offset-2 hover:underline'
        }
      >
        root
      </button>
      {view.kind !== 'collections' ? (
        <>
          <span className="text-slate-gray/60">/</span>
          <button
            type="button"
            onClick={() => onNavigate({ kind: 'documents', coll: view.coll })}
            className={
              view.kind === 'documents'
                ? 'text-soft-white'
                : 'text-slate-gray hover:text-soft-white underline-offset-2 hover:underline'
            }
          >
            {view.coll.id}
          </button>
        </>
      ) : null}
      {view.kind === 'document' ? (
        <>
          <span className="text-slate-gray/60">/</span>
          <span className="text-soft-white">{view.ref.id}</span>
        </>
      ) : null}
    </div>
  );
}
