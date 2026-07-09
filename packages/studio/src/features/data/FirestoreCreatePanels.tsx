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

import { useState } from 'react';
import {
  DocumentEditor,
  treeToData,
  validateCollectionId,
  validateDocumentId,
  parseImport,
  detectCollisions,
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
  /** Existing document ids in the target collection (collision detection). */
  existingIds: string[];
  createDocument: (id: string | null, data: Record<string, unknown>) => Promise<unknown>;
  onDone: () => void;
  onCancel: () => void;
}

type CollisionPolicy = 'skip' | 'overwrite';

/**
 * Paste-or-file JSON import. Parsing/preview/collision-detection is the pure
 * `parseImport`/`detectCollisions` logic in `@pyric/ui/firestore` — this
 * component only renders the preview and drives the (sequential, per point
 * 10 of the task — no batch-write primitive exists yet) writes. The
 * skip-or-overwrite choice is disclosed ONLY when `detectCollisions` finds an
 * overlap (never preemptively), matching the pane's inline-disclosure rule.
 */
export function ImportJsonPanel({ existingIds, createDocument, onDone, onCancel }: ImportJsonPanelProps) {
  const [text, setText] = useState('');
  const [policy, setPolicy] = useState<CollisionPolicy>('skip');
  const [result, setResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const parsed = parseImport(text);
  const collisions = detectCollisions(existingIds, parsed.docs);
  const hasInput = text.trim() !== '';

  const onFile = (file: File) => {
    file.text().then(setText).catch(() => {});
  };

  const run = async () => {
    if (!parsed.docs.length || busy) return;
    setBusy(true);
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const doc of parsed.docs) {
      if (doc.id !== null && collisions.includes(doc.id) && policy === 'skip') {
        skipped++;
        continue;
      }
      try {
        await createDocument(doc.id, doc.data);
        created++;
      } catch (e) {
        errors.push(`${doc.id ?? '(auto)'}: ${e instanceof Error ? e.message : String(e)}`);
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

      {hasInput ? (
        <div className="fs-import__preview" data-pyric-ui="fs-import-preview">
          <p className="fs-import__count">
            {parsed.errors.length && parsed.docs.length === 0
              ? 'No valid documents found.'
              : `Will create ${parsed.docs.length} document(s).`}
          </p>
          {parsed.errors.length ? (
            <ul className="fs-import__errs">
              {parsed.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
          {collisions.length ? (
            <div className="fs-import__collisions" data-pyric-ui="fs-import-collisions">
              <p>
                {collisions.length} id(s) already exist: <code>{collisions.join(', ')}</code>
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
        <p className="fs-import__result">
          Created {result.created}
          {result.skipped ? `, skipped ${result.skipped}` : ''}
          {result.errors.length ? `, ${result.errors.length} failed` : ''}.
        </p>
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
