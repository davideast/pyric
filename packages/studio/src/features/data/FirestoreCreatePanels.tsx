/**
 * Firestore create-collection / create-document / import-JSON affordances
 * (F2). Sibling to `FirestorePane.tsx` (same split as `AuthPane.tsx` +
 * `FirestoreSeedBox.tsx`): the pane composes these; they don't know about
 * navigation or the miller-column shell.
 *
 * Per `docs/design/PRINCIPLES.md` (C3/C4): each affordance is a disclosed
 * INLINE PANE under its own "+ New …" / "Import JSON" toggle, not a modal,
 * and each pane has exactly one primary action (Create / Import). The
 * document/collection field editor reuses the library's `<DocumentEditor>`
 * (the same typed per-field editing `DocumentEditPanel` in `FirestorePane.tsx`
 * uses for editing an existing document) rather than inventing a second
 * field-editor idiom — starting it from `initial={{}}` gives an empty map
 * root the user grows with "+ Add field", including nested map/array via the
 * existing map/array editors (no separate JSON sub-editor needed for v1).
 *
 * Writes go through the SAME `FirestoreApi` bundle (`useFirestoreApi()`) the
 * rest of the pane uses — in-process `pyric/firestore` in dev-seed review,
 * the SharedWorker client bundle in served mode. No new backend ops: create-
 * document is `setDoc`/`addDoc`; JSON import is N sequential `setDoc`/`addDoc`
 * calls through that same handle (there is no batch-write primitive on
 * `FirestoreApi` today — see `packages/ui/src/firestore/firestoreApi.ts`).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  DocumentEditor,
  treeToData,
  validateCollectionId,
  validateDocumentId,
  parseImport,
  detectCollisions,
  firestoreAutoId,
  type DocumentEditorRootProps,
} from '@pyric/ui/firestore';
import type { FirestoreApi } from '@pyric/ui/firestore';

type EditorState = Parameters<NonNullable<DocumentEditorRootProps['onChange']>>[0];

/** Shared id-picker row: "Auto ID" toggle vs a custom-id text input. */
function IdField({
  idMode,
  setIdMode,
  customId,
  setCustomId,
  idError,
}: {
  idMode: 'auto' | 'custom';
  setIdMode: (m: 'auto' | 'custom') => void;
  customId: string;
  setCustomId: (v: string) => void;
  idError: string | undefined;
}) {
  return (
    <div className="fs-create__id" data-pyric-ui="fs-create-id">
      <label className="fs-create__idmode">
        <input
          type="radio"
          name="fs-create-id-mode"
          checked={idMode === 'auto'}
          onChange={() => setIdMode('auto')}
        />
        Auto-ID
      </label>
      <label className="fs-create__idmode">
        <input
          type="radio"
          name="fs-create-id-mode"
          checked={idMode === 'custom'}
          onChange={() => setIdMode('custom')}
        />
        <input
          type="text"
          placeholder="Document ID"
          value={customId}
          disabled={idMode !== 'custom'}
          onChange={(e) => {
            setIdMode('custom');
            setCustomId(e.target.value);
          }}
          data-pyric-field="doc-id"
          aria-invalid={idError ? 'true' : undefined}
        />
      </label>
      {idError ? <span className="fs-create__err">{idError}</span> : null}
    </div>
  );
}

// ─── Create collection ──────────────────────────────────────────────────────

export interface NewCollectionFormProps {
  api: Pick<FirestoreApi, 'collection' | 'doc' | 'setDoc' | 'addDoc'>;
  firestore: Parameters<FirestoreApi['collection']>[0];
  /** Fired after the write succeeds, with the new collection + doc id, so the
   *  pane can navigate straight into it (which also refreshes the root
   *  collection list — see `LiveFirestorePane`). */
  onCreated: (collectionId: string, docId: string) => void;
  onCancel: () => void;
}

/**
 * "New collection" = collection id + its first document, since Firestore
 * collections don't exist independently of a document (C1/C3: disclosed
 * inline, one primary action — Create).
 */
export function NewCollectionForm({ api, firestore, onCreated, onCancel }: NewCollectionFormProps) {
  const [collectionId, setCollectionId] = useState('');
  const [idMode, setIdMode] = useState<'auto' | 'custom'>('auto');
  const [customId, setCustomId] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const collectionIdError = collectionId ? validateCollectionId(collectionId) : undefined;
  const docIdError = idMode === 'custom' && customId ? validateDocumentId(customId) : undefined;
  const canSubmit =
    !!collectionId &&
    !collectionIdError &&
    !(idMode === 'custom' && (!customId || docIdError)) &&
    !!editor?.isValid &&
    !busy;

  const submit = async () => {
    if (!canSubmit || !editor) return;
    setBusy(true);
    setError(null);
    try {
      const data = treeToData(editor.tree);
      const coll = api.collection(firestore, collectionId);
      if (idMode === 'auto') {
        const ref = await api.addDoc(coll, data);
        onCreated(collectionId, ref.id);
      } else {
        const ref = api.doc(coll, customId);
        await api.setDoc(ref, data);
        onCreated(collectionId, customId);
      }
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setBusy(false);
    }
  };

  return (
    <div className="fs-create" data-pyric-ui="fs-new-collection">
      <label className="fs-create__collid">
        <span className="fs-create__label">Collection ID</span>
        <input
          type="text"
          value={collectionId}
          onChange={(e) => setCollectionId(e.target.value)}
          placeholder="e.g. users"
          data-pyric-field="collection-id"
          aria-invalid={collectionIdError ? 'true' : undefined}
        />
        {collectionIdError ? <span className="fs-create__err">{collectionIdError}</span> : null}
      </label>

      <p className="fs-create__hint">First document</p>
      <IdField
        idMode={idMode}
        setIdMode={setIdMode}
        customId={customId}
        setCustomId={setCustomId}
        idError={docIdError}
      />

      <DocumentEditor.Root initial={{}} onChange={setEditor}>
        <DocumentEditor.Fields />
      </DocumentEditor.Root>

      {error ? <p className="fs-create__err">{error.message}</p> : null}

      <div className="fs-create__actions">
        <button type="button" className="fs-editor__save" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button type="button" className="fs-editor__cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Create document ────────────────────────────────────────────────────────

export interface NewDocumentFormProps {
  /** Create a document in the already-known target collection. Wired to
   *  `useDocumentList().createDocument` from the pane (id === null => auto). */
  createDocument: (id: string | null, data: Record<string, unknown>) => Promise<unknown>;
  onCreated: () => void;
  onCancel: () => void;
}

export function NewDocumentForm({ createDocument, onCreated, onCancel }: NewDocumentFormProps) {
  const [idMode, setIdMode] = useState<'auto' | 'custom'>('auto');
  const [customId, setCustomId] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const docIdError = idMode === 'custom' && customId ? validateDocumentId(customId) : undefined;
  const canSubmit = !(idMode === 'custom' && (!customId || docIdError)) && !!editor?.isValid && !busy;

  const submit = async () => {
    if (!canSubmit || !editor) return;
    setBusy(true);
    setError(null);
    try {
      await createDocument(idMode === 'auto' ? null : customId, treeToData(editor.tree));
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setBusy(false);
    }
  };

  return (
    <div className="fs-create" data-pyric-ui="fs-new-document">
      <IdField
        idMode={idMode}
        setIdMode={setIdMode}
        customId={customId}
        setCustomId={setCustomId}
        idError={docIdError}
      />

      <DocumentEditor.Root initial={{}} onChange={setEditor}>
        <DocumentEditor.Fields />
      </DocumentEditor.Root>

      {error ? <p className="fs-create__err">{error.message}</p> : null}

      <div className="fs-create__actions">
        <button type="button" className="fs-editor__save" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? 'Creating…' : 'Create document'}
        </button>
        <button type="button" className="fs-editor__cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── JSON import ────────────────────────────────────────────────────────────

export interface ImportJsonPanelProps {
  /** Document ids LOADED in the pane (one page) — used only for the advisory
   *  collision preview. The skip guarantee itself is enforced at write time
   *  via create semantics, so unloaded pages are covered too. */
  existingIds: string[];
  createDocument: (
    id: string | null,
    data: Record<string, unknown>,
    opts?: { onExisting?: 'overwrite' | 'fail' },
  ) => Promise<unknown>;
  onDone: () => void;
  onCancel: () => void;
}

type CollisionPolicy = 'skip' | 'overwrite';

/** Don't parse pastes beyond this (the sequential per-doc write path isn't a
 *  bulk loader; a bigger import belongs in a seed script). */
const MAX_IMPORT_CHARS = 1_000_000;
/** Cap rendered error/collision enumerations (M-honesty without a DOM flood). */
const MAX_LISTED_ERRORS = 20;
const MAX_LISTED_COLLISIONS = 10;

/** First N items + an "… and N more" line. */
function capList(items: readonly string[], max: number): { shown: string[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/**
 * Paste-or-file JSON import. Parsing/preview/collision-detection is the pure
 * `parseImport`/`detectCollisions` logic in `@pyric/ui/firestore` — this
 * component only renders the preview and drives the (sequential — no
 * batch-write primitive exists yet) writes.
 *
 * Skip vs overwrite: "skip existing" is enforced with CREATE semantics at
 * write time (`onExisting: 'fail'`, counted as skipped) — authoritative for
 * the whole collection, not just the loaded page. `detectCollisions` against
 * the loaded ids remains as an ADVISORY preview only, and is labeled as such.
 * The choice is disclosed ONLY when the preview finds an overlap.
 *
 * Retry safety: the parse is memoized off the (debounced) text and array-shape
 * docs get their auto-ids FIXED at parse time, so re-running after a partial
 * failure reuses the same ids — skip mode then skips what already landed
 * instead of duplicating it.
 */
export function ImportJsonPanel({ existingIds, createDocument, onDone, onCancel }: ImportJsonPanelProps) {
  const [text, setText] = useState('');
  const [policy, setPolicy] = useState<CollisionPolicy>('skip');
  const [result, setResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  // Debounce the parse input so `parseImport` runs off the keystroke path
  // (M9), then memoize the parse itself — the memo also pins the generated
  // auto-ids for the retry-idempotency guarantee above.
  const [parseText, setParseText] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setParseText(text), 150);
    return () => clearTimeout(t);
  }, [text]);
  const tooLarge = parseText.length > MAX_IMPORT_CHARS;
  const parsed = useMemo(
    () =>
      tooLarge
        ? { docs: [], errors: [] as string[] }
        : parseImport(parseText, { generateId: firestoreAutoId }),
    [parseText, tooLarge],
  );
  const collisions = useMemo(
    () => detectCollisions(existingIds, parsed.docs),
    [existingIds, parsed],
  );
  const hasInput = parseText.trim() !== '';

  const onFile = (file: File) => {
    file.text().then(setText).catch(() => {});
  };

  const run = async () => {
    if (!parsed.docs.length || busy) return;
    setBusy(true);
    setResult(null);
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const doc of parsed.docs) {
      try {
        // Skip mode = create semantics: the backend (not the loaded page)
        // decides what already exists; already-exists counts as skipped.
        await createDocument(doc.id, doc.data, {
          onExisting: policy === 'skip' ? 'fail' : 'overwrite',
        });
        created++;
      } catch (e) {
        if (policy === 'skip' && (e as { code?: string }).code === 'already-exists') {
          skipped++;
        } else {
          errors.push(`${doc.id ?? '(auto)'}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    setBusy(false);
    setResult({ created, skipped, errors });
    if (errors.length === 0) onDone();
  };

  return (
    <div className="fs-create fs-import" data-pyric-ui="fs-import-json">
      <label className="fs-create__label" htmlFor="fs-import-text">
        Paste JSON — either <code>{'{ "docId": { ...fields }, ... }'}</code> or an array of objects
        (auto-id each)
      </label>
      <textarea
        id="fs-import-text"
        className="fs-import__textarea"
        value={text}
        spellCheck={false}
        rows={10}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
        placeholder='{"alice": {"name": "Alice"}}  or  [{"name": "Alice"}]'
      />
      <input
        type="file"
        accept="application/json,.json"
        className="fs-import__file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />

      {tooLarge ? (
        <p className="fs-import__count" data-pyric-ui="fs-import-too-large">
          Input is too large to import here ({Math.round(parseText.length / 1000)}k characters;
          the limit is {MAX_IMPORT_CHARS / 1000}k). Use a seed script for bulk data.
        </p>
      ) : null}

      {hasInput && !tooLarge ? (
        <div className="fs-import__preview" data-pyric-ui="fs-import-preview">
          <p className="fs-import__count">
            {parsed.errors.length && parsed.docs.length === 0
              ? 'No valid documents found.'
              : `Will create ${parsed.docs.length} document(s).`}
          </p>
          {parsed.errors.length ? (
            <ul className="fs-import__errs">
              {capList(parsed.errors, MAX_LISTED_ERRORS).shown.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {capList(parsed.errors, MAX_LISTED_ERRORS).more ? (
                <li>… and {capList(parsed.errors, MAX_LISTED_ERRORS).more} more</li>
              ) : null}
            </ul>
          ) : null}
          {collisions.length ? (
            <div className="fs-import__collisions" data-pyric-ui="fs-import-collisions">
              <p>
                {collisions.length} id(s) collide among the loaded documents (more pages may
                exist — "Skip existing" checks every document at write time):{' '}
                <code>
                  {capList(collisions, MAX_LISTED_COLLISIONS).shown.join(', ')}
                  {capList(collisions, MAX_LISTED_COLLISIONS).more
                    ? `, … and ${capList(collisions, MAX_LISTED_COLLISIONS).more} more`
                    : ''}
                </code>
              </p>
              <label>
                <input
                  type="radio"
                  name="fs-import-policy"
                  checked={policy === 'skip'}
                  onChange={() => setPolicy('skip')}
                />
                Skip existing
              </label>
              <label>
                <input
                  type="radio"
                  name="fs-import-policy"
                  checked={policy === 'overwrite'}
                  onChange={() => setPolicy('overwrite')}
                />
                Overwrite existing
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className="fs-import__result" data-pyric-ui="fs-import-result">
          <p>
            Created {result.created}
            {result.skipped ? `, skipped ${result.skipped}` : ''}
            {result.errors.length ? `, ${result.errors.length} failed` : ''}.
          </p>
          {result.errors.length ? (
            <ul className="fs-import__errs">
              {capList(result.errors, MAX_LISTED_ERRORS).shown.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {capList(result.errors, MAX_LISTED_ERRORS).more ? (
                <li>… and {capList(result.errors, MAX_LISTED_ERRORS).more} more</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="fs-create__actions">
        <button
          type="button"
          className="fs-editor__save"
          disabled={!parsed.docs.length || busy}
          onClick={() => void run()}
        >
          {busy ? 'Importing…' : 'Import'}
        </button>
        <button type="button" className="fs-editor__cancel" onClick={onCancel}>
          {result ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
