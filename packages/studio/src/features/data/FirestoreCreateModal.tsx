/**
 * Firestore create-collection / create-document MODAL (F2) — a clean-room
 * take on firebase-tools-ui's composable add-collection/add-document dialog
 * flow (studied from `clones/firebase-tools-ui`; no code copied):
 *
 * - "Start a collection" is ONE modal composing the collection-id step with
 *   the document step (a collection only exists once it has a document);
 * - "Add a document" is the SAME modal opened at the document step, with the
 *   target collection fixed;
 * - a DOCUMENT spawns a SUBCOLLECTION through the same modal, the collection
 *   step seeded with the parent document path — it's the tree, composable.
 *
 * The machinery is the panels' proven kit, rewrapped: id validation
 * (`validateCollectionId` / `validateDocumentId`, incl. the 1500-byte caps),
 * CREATE-vs-overwrite semantics via a `getDoc` probe (never silently clobber
 * an existing document), and the library `<DocumentEditor>` field registry
 * for typed fields. The document id is pre-filled with a Firestore auto-id
 * (`firestoreAutoId`) and stays editable — auto by default, custom by typing.
 *
 * Form law: every label is STACKED ABOVE its control; labels and errors are
 * smaller text spaced tight to their group; groups are spaced further apart;
 * one primary action (Save).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DocumentEditor,
  treeToData,
  validateCollectionId,
  validateDocumentId,
  firestoreAutoId,
  type DocumentEditorRootProps,
} from '@pyric/ui/firestore';

type EditorState = Parameters<NonNullable<DocumentEditorRootProps['onChange']>>[0];

export interface FirestoreCreateSubmit {
  /** Present in collection mode; `null` in document mode (collection fixed). */
  collectionId: string | null;
  docId: string;
  data: Record<string, unknown>;
}

export interface FirestoreCreateModalProps {
  /** `collection`: collection-id step + document step. `document`: document
   *  step only (the target collection is fixed by the caller). */
  mode: 'collection' | 'document';
  /** Read-only context line: where the new node lands. `'/'` for root. */
  parentPath: string;
  /** Perform the write. Throw to surface an inline error (e.g. the create
   *  probe finding an existing document). The caller owns navigation. */
  onCreate: (submit: FirestoreCreateSubmit) => Promise<void>;
  onClose: () => void;
}

/** One stacked form group: small label tight over the control, error line
 *  (smaller, tight) under it. Alignment comes from the modal's layout column,
 *  never per-element nudges. */
function Group({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="fs-modal__group">
      <span className="fs-modal__label">{label}</span>
      {children}
      {error ? (
        <span className="fs-modal__err" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="fs-modal__hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function FirestoreCreateModal({
  mode,
  parentPath,
  onCreate,
  onClose,
}: FirestoreCreateModalProps) {
  const [collectionId, setCollectionId] = useState('');
  // Emulator-ui form: the document id is PRE-FILLED with an auto-id and
  // editable — "auto" is the default, "custom" is typing over it.
  const [docId, setDocId] = useState(() => firestoreAutoId());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const collectionIdError =
    mode === 'collection' && collectionId ? validateCollectionId(collectionId) : undefined;
  const docIdError = docId ? validateDocumentId(docId) : undefined;
  // The id fields are disabled-gated directly (there's no per-field touch
  // state for them — they're single inputs, not a tree). The field editor's
  // OWN errors don't disable the button: a submit attempt instead sweeps
  // `touchAll()` so hidden field errors reveal themselves, matching "errors
  // appear after touch OR a submit attempt."
  const idsValid =
    !(mode === 'collection' && (!collectionId || collectionIdError)) && !!docId && !docIdError;
  const canSubmit = idsValid && !busy;

  // Escape closes (unless a write is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async () => {
    if (!canSubmit || !editor) return;
    if (!editor.isValid) {
      // Submit attempt while the field tree has hidden (untouched)
      // errors: reveal them instead of silently doing nothing.
      editor.touchAll();
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      await onCreate({
        collectionId: mode === 'collection' ? collectionId : null,
        docId,
        data: treeToData(editor.tree),
      });
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e : new Error(String(e)));
      setBusy(false);
    }
  };

  const title = mode === 'collection' ? 'Start a collection' : 'Add a document';

  return (
    <div
      className="fs-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="fs-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-pyric-ui="fs-create-modal"
        data-fs-create-mode={mode}
      >
        <h2 className="fs-modal__title">{title}</h2>

        <Group label="Parent path">
          <span className="fs-modal__path">{parentPath}</span>
        </Group>

        {mode === 'collection' ? (
          <Group label="Collection ID" error={collectionIdError}>
            <input
              autoFocus
              type="text"
              value={collectionId}
              placeholder="e.g. users"
              onChange={(e) => setCollectionId(e.target.value)}
              data-pyric-field="collection-id"
              aria-invalid={collectionIdError ? 'true' : undefined}
            />
          </Group>
        ) : null}

        <Group
          label="Document ID"
          error={docId ? docIdError : 'Cannot be empty'}
          hint="Auto-generated — edit to set your own."
        >
          <input
            autoFocus={mode === 'document'}
            type="text"
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            data-pyric-field="doc-id"
            aria-invalid={docIdError || !docId ? 'true' : undefined}
          />
        </Group>

        <div className="fs-modal__group">
          <span className="fs-modal__label">Fields</span>
          <div className="fs-modal__fields">
            <DocumentEditor.Root initial={{}} onChange={setEditor}>
              <DocumentEditor.Fields />
            </DocumentEditor.Root>
          </div>
        </div>

        {submitError ? (
          <p className="fs-modal__err" role="alert">
            {submitError.message}
          </p>
        ) : null}

        <div className="fs-modal__actions">
          <button type="button" className="fs-editor__cancel" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="fs-editor__save"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
