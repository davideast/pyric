import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useDocumentEditor, type UseDocumentEditorResult } from '../hooks/useDocumentEditor.js';
import { mergeFieldEditors } from '../fieldEditors/registry.js';
import type { FieldEditorRegistry } from '../fieldEditors/types.js';
import type { FieldNode } from '../reducers/types.js';
import type { FieldType } from '../types.js';
import { useContainerSize } from '../../primitives/hooks/useContainerSize.js';

interface EditorContext {
  editor: UseDocumentEditorResult;
  fieldEditors: FieldEditorRegistry;
}

const Ctx = createContext<EditorContext | null>(null);

function useEditorContext(): EditorContext {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      'DocumentEditor.* components must render inside <DocumentEditor.Root>',
    );
  }
  return ctx;
}

export interface DocumentEditorRootProps {
  /** Initial document data. Built into the editor's tree on first
   *  mount; later changes don't rebuild — call `editor.reset()` to
   *  re-initialize from a fresh `initial`. */
  initial?: Record<string, unknown>;
  /** Override or extend the built-in field editors. */
  fieldEditors?: FieldEditorRegistry;
  /** Called on every state change with the latest editor state. The
   *  parent typically watches `state.isValid` + `state.isDirty` to
   *  enable/disable a Save button. */
  onChange?: (state: UseDocumentEditorResult) => void;
  children: ReactNode;
  className?: string;
}

/**
 * Wires the `useDocumentEditor` hook + field-editor registry into a
 * React context so `<DocumentEditor.Fields>` and `<DocumentEditor.AddField>`
 * can render the tree without prop drilling.
 *
 * Pattern: hook + compound component. Consumers wanting full control
 * over the layout call `useDocumentEditor` directly and render their
 * own tree; consumers wanting the default rendering use this.
 */
export function DocumentEditorRoot({
  initial,
  fieldEditors,
  onChange,
  children,
  className,
}: DocumentEditorRootProps) {
  const editor = useDocumentEditor({ initial });
  const registry = mergeFieldEditors(fieldEditors);

  // Hold the latest onChange in a ref so the effect's deps don't
  // include the callback — avoids re-firing onChange on every parent
  // re-render that produces a new function identity.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current?.(editor);
  }, [editor]);

  const { ref: rootRef, size } = useContainerSize<HTMLDivElement>();

  return (
    <Ctx.Provider value={{ editor, fieldEditors: registry }}>
      <div
        ref={rootRef}
        className={className}
        data-pyric-ui="document-editor"
        data-pyric-is-valid={editor.isValid ? '' : undefined}
        data-pyric-is-dirty={editor.isDirty ? '' : undefined}
        data-size={size}
      >
        {children}
      </div>
    </Ctx.Provider>
  );
}

/** Read access to the underlying editor state from inside a Root. */
export function useDocumentEditorContext(): UseDocumentEditorResult {
  return useEditorContext().editor;
}

/**
 * Renders the top-level fields of the document. For finer control,
 * a consumer can call `useDocumentEditorContext()` and render the
 * tree themselves.
 */
export function DocumentEditorFields() {
  const { editor } = useEditorContext();
  // Stable INSERTION order, never re-sorted by the (currently being
  // typed) key — `childIds` already preserves the order fields were
  // added in, which is exactly what must stay stable while a row's
  // name is edited. Sorting here was the cause of rows visibly
  // reordering mid-keystroke.
  const rootChildren = editor.tree.childIds[editor.tree.rootId] ?? [];

  return (
    <div data-pyric-editor-fields>
      {rootChildren.map((id) => (
        <Field key={id} nodeId={id} path={fieldPath(editor, id)} />
      ))}
      <AddMapEntry parentId={editor.tree.rootId} />
    </div>
  );
}

function fieldPath(editor: UseDocumentEditorResult, nodeId: string): string {
  const segments: string[] = [];
  let current: FieldNode | undefined = editor.tree.nodes[nodeId];
  while (current && current.parentId != null) {
    const parent: FieldNode | undefined = editor.tree.nodes[current.parentId];
    if (!parent) break;
    if (parent.type === 'array') {
      const idx = (editor.tree.childIds[parent.id] ?? []).indexOf(current.id);
      segments.unshift(`[${idx}]`);
    } else {
      segments.unshift(current.key ?? '');
    }
    current = parent;
  }
  // Join — array index segments don't take a leading dot.
  return segments.reduce((acc, seg) => {
    if (seg.startsWith('[')) return `${acc}${seg}`;
    return acc ? `${acc}.${seg}` : seg;
  }, '');
}

interface FieldProps {
  nodeId: string;
  path: string;
}

function Field({ nodeId, path }: FieldProps) {
  const { editor, fieldEditors } = useEditorContext();
  const node = editor.tree.nodes[nodeId];
  if (!node) return null;

  if (node.type === 'map') {
    return <MapField node={node} path={path} />;
  }
  if (node.type === 'array') {
    return <ArrayField node={node} path={path} />;
  }

  const contract = fieldEditors[node.type];
  const EditComponent = contract?.Edit;
  if (!EditComponent) return null;

  // Errors are computed on every keystroke (so Save can gate on
  // `isValid`), but only DISPLAYED once the field has been touched
  // (blurred) or a submit attempt swept the tree — otherwise a
  // freshly-added empty row would show "required" before the user
  // has typed anything.
  const showError = node.touched ? node.error : undefined;

  return (
    <div
      data-pyric-field-entry
      data-field-name={node.key ?? undefined}
      data-pyric-error={showError ? '' : undefined}
      onBlur={() => editor.touch(node.id)}
    >
      <FieldChrome node={node} path={path} />
      <EditComponent
        value={node.value as never}
        path={path}
        error={showError}
        onChange={(v: unknown) => editor.setValue(node.id, v)}
      />
    </div>
  );
}

/**
 * Per-field chrome: the field's key input (for map children), the
 * type selector, and the remove button. Inline at every non-root
 * node so consumers can hide individual pieces via `data-*` CSS.
 */
function FieldChrome({ node, path }: { node: FieldNode; path: string }) {
  const { editor } = useEditorContext();
  const parent = node.parentId != null ? editor.tree.nodes[node.parentId] : null;
  const inMap = parent?.type === 'map';
  const isRoot = node.id === editor.tree.rootId;

  if (isRoot) return null;

  return (
    <div data-pyric-field-chrome data-pyric-field-path={path}>
      {inMap ? (
        <input
          type="text"
          value={node.key ?? ''}
          onChange={(e) => editor.setKey(node.id, e.target.value)}
          aria-label="Field name"
          data-pyric-field-key-input
          aria-invalid={node.touched && node.error ? 'true' : undefined}
        />
      ) : null}
      <TypeSelect node={node} />
      <button
        type="button"
        onClick={() => editor.remove(node.id)}
        data-pyric-remove
        aria-label="Remove field"
      >
        ×
      </button>
    </div>
  );
}

const ALL_TYPES: FieldType[] = [
  'string',
  'number',
  'boolean',
  'null',
  'timestamp',
  'geopoint',
  'reference',
  'bytes',
  'vector',
  'map',
  'array',
];

function TypeSelect({ node }: { node: FieldNode }) {
  const { editor } = useEditorContext();
  const parent = node.parentId != null ? editor.tree.nodes[node.parentId] : null;
  // Firestore disallows nested arrays — filter that option out
  // when the parent is an array.
  const options = ALL_TYPES.filter((t) => !(parent?.type === 'array' && t === 'array'));

  return (
    <select
      value={node.type}
      onChange={(e) => editor.setType(node.id, e.target.value as FieldType)}
      aria-label="Field type"
      data-pyric-field-type-select
    >
      {options.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

interface ContainerFieldProps {
  node: FieldNode;
  path: string;
}

function MapField({ node, path }: ContainerFieldProps) {
  const { editor } = useEditorContext();
  // Stable insertion order — same rationale as `DocumentEditorFields`.
  const children = editor.tree.childIds[node.id] ?? [];

  return (
    <div
      data-pyric-field-entry
      data-pyric-field-type="map"
      data-field-name={node.key ?? undefined}
    >
      {node.id !== editor.tree.rootId ? <FieldChrome node={node} path={path} /> : null}
      <div data-pyric-map-children>
        {children.map((childId) => {
          const child = editor.tree.nodes[childId];
          if (!child) return null;
          const childPath = path ? `${path}.${child.key ?? ''}` : child.key ?? '';
          return <Field key={childId} nodeId={childId} path={childPath} />;
        })}
      </div>
      <AddMapEntry parentId={node.id} />
    </div>
  );
}

function ArrayField({ node, path }: ContainerFieldProps) {
  const { editor } = useEditorContext();
  const children = editor.tree.childIds[node.id] ?? [];

  return (
    <div
      data-pyric-field-entry
      data-pyric-field-type="array"
      data-field-name={node.key ?? undefined}
    >
      <FieldChrome node={node} path={path} />
      <ol data-pyric-array-children>
        {children.map((childId, idx) => {
          const childPath = path ? `${path}[${idx}]` : `[${idx}]`;
          return (
            <li key={childId} data-field-index={String(idx)}>
              <Field nodeId={childId} path={childPath} />
            </li>
          );
        })}
      </ol>
      <AddArrayEntry parentId={node.id} />
    </div>
  );
}

function AddMapEntry({ parentId }: { parentId: string }) {
  const { editor } = useEditorContext();
  return (
    <button
      type="button"
      data-pyric-add-map-entry
      onClick={() => editor.addMapEntry(parentId, '', 'string')}
    >
      + Add field
    </button>
  );
}

function AddArrayEntry({ parentId }: { parentId: string }) {
  const { editor } = useEditorContext();
  return (
    <button
      type="button"
      data-pyric-add-array-entry
      onClick={() => editor.addArrayEntry(parentId, 'string')}
    >
      + Add item
    </button>
  );
}

/**
 * Compound root export. Consumers pattern-match via dot access:
 *
 *   <DocumentEditor.Root initial={data} onChange={…}>
 *     <DocumentEditor.Fields />
 *   </DocumentEditor.Root>
 */
export const DocumentEditor = {
  Root: DocumentEditorRoot,
  Fields: DocumentEditorFields,
};
