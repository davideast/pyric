/**
 * Pure logic for `FirestoreDocumentTree` — deliberately React-free so it's
 * testable with plain `bun:test` (no `@testing-library/react`, which is a
 * `@pyric/ui`-only devDependency; Studio's test setup has never needed a
 * DOM-rendering harness, and this repo doesn't add new dependencies to get
 * one). Path/preview/validation helpers live here; the component just wires
 * them into JSX + row state.
 */

import type {
  EditorTree,
  FieldNode,
  FieldType,
  VectorView,
} from '@pyric/ui/firestore';

type FirestoreRowSegment = ['field', string] | ['index', number];

function encodeFirestoreRowSegments(segments: readonly FirestoreRowSegment[]): string {
  return JSON.stringify(segments);
}

/** Build one comparison fingerprint per rendered Firestore row. Container
 * fingerprints include only their direct child shape, so a leaf update does
 * not light every ancestor; additions/removals still light the parent row. */
export function firestoreDataUpdateEntries(
  data: Record<string, unknown>,
  infer: (value: unknown) => FieldType,
): ReadonlyMap<string, unknown> {
  const entries = new Map<string, unknown>();

  const visit = (value: unknown, segments: FirestoreRowSegment[]) => {
    const type = infer(value);
    const identity = encodeFirestoreRowSegments(segments);
    if (type === 'map') {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      entries.set(identity, [type, keys]);
      for (const key of keys) {
        visit(record[key], [...segments, ['field', key]]);
      }
      return;
    }
    if (type === 'array') {
      const values = value as unknown[];
      entries.set(identity, [type, values.map((_, index) => String(index))]);
      values.forEach((child, index) => visit(child, [...segments, ['index', index]]));
      return;
    }
    entries.set(identity, [type, value]);
  };

  for (const [key, value] of Object.entries(data)) {
    visit(value, [['field', key]]);
  }
  return entries;
}

/** Collision-free identity for update/expansion state. Unlike the display
 * path, typed segments distinguish literal dots/brackets from nesting. */
export function firestoreRowIdentity(tree: EditorTree, nodeId: string): string {
  const segments: FirestoreRowSegment[] = [];
  let current: FieldNode | undefined = tree.nodes[nodeId];
  while (current && current.parentId != null) {
    const parent: FieldNode | undefined = tree.nodes[current.parentId];
    if (!parent) break;
    if (parent.type === 'array') {
      segments.unshift(['index', (tree.childIds[parent.id] ?? []).indexOf(current.id)]);
    } else {
      segments.unshift(['field', current.key ?? '']);
    }
    current = parent;
  }
  return encodeFirestoreRowSegments(segments);
}

/**
 * Path from the tree root to a node, for `[data-pyric-field-path]` hooks on
 * the Display/Edit contracts (mirrors `DocumentEditor.tsx`'s private
 * `fieldPath` in `@pyric/ui` — five lines, not worth an export there for one
 * caller).
 */
export function fieldPath(tree: EditorTree, nodeId: string): string {
  const segments: string[] = [];
  let current: FieldNode | undefined = tree.nodes[nodeId];
  while (current && current.parentId != null) {
    const parent: FieldNode | undefined = tree.nodes[current.parentId];
    if (!parent) break;
    if (parent.type === 'array') {
      const idx = (tree.childIds[parent.id] ?? []).indexOf(current.id);
      segments.unshift(`[${idx}]`);
    } else {
      segments.unshift(current.key ?? '');
    }
    current = parent;
  }
  return segments.reduce(
    (acc, seg) => (seg.startsWith('[') ? `${acc}${seg}` : acc ? `${acc}.${seg}` : seg),
    '',
  );
}

/** The row LABEL for a node: its map key, or — for an array child — the
 *  chip text, which is its positional index in the parent's `childIds`
 *  (never the map-style key, array children don't carry one). */
export function rowLabel(tree: EditorTree, nodeId: string): { label: string; isArrayChild: boolean } {
  const node = tree.nodes[nodeId];
  const parent = node?.parentId != null ? tree.nodes[node.parentId] : null;
  if (parent?.type === 'array') {
    const index = (tree.childIds[parent.id] ?? []).indexOf(nodeId);
    return { label: String(index), isArrayChild: true };
  }
  return { label: node?.key ?? '', isArrayChild: false };
}

function leafPreview(
  node: FieldNode,
  asVectorView: (v: unknown) => VectorView | null,
  vectorPreview: (v: VectorView) => string,
): string {
  switch (node.type) {
    case 'map':
      return '{…}';
    case 'array':
      return '[…]';
    case 'string':
      return JSON.stringify(node.value);
    case 'null':
      return 'null';
    case 'vector': {
      const v = asVectorView(node.value);
      return v ? vectorPreview(v as never) : 'vector';
    }
    default:
      return String(node.value);
  }
}

const PREVIEW_MAX = 42;

/**
 * Collapsed-container preview: `{"_values": [-0.019…, …}` / `["5k", "10k",
 * …]`, truncated so a huge array/embedding never dumps its full contents
 * into a collapsed row.
 *
 * Takes `asVectorView`/`vectorPreview` as parameters rather than importing
 * them directly so this stays a pure function of its inputs — no import of
 * `@pyric/ui/firestore`'s runtime beyond the `EditorTree`/`FieldNode`
 * TYPES, which keeps this module trivially unit-testable with synthetic
 * trees.
 */
export function containerPreview(
  tree: EditorTree,
  nodeId: string,
  vectorHelpers: {
    asVectorView: (v: unknown) => VectorView | null;
    vectorPreview: (v: VectorView) => string;
  },
  max: number = PREVIEW_MAX,
): string {
  const node = tree.nodes[nodeId]!;
  const kids = tree.childIds[nodeId] ?? [];
  let text: string;
  if (node.type === 'array') {
    const parts = kids
      .slice(0, 3)
      .map((id) => leafPreview(tree.nodes[id]!, vectorHelpers.asVectorView, vectorHelpers.vectorPreview));
    text = `[${parts.join(', ')}${kids.length > 3 ? ', …' : ''}]`;
  } else {
    const parts = kids
      .slice(0, 2)
      .map(
        (id) =>
          `"${tree.nodes[id]!.key}": ${leafPreview(tree.nodes[id]!, vectorHelpers.asVectorView, vectorHelpers.vectorPreview)}`,
      );
    text = `{${parts.join(', ')}${kids.length > 2 ? ', …' : ''}}`;
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Sibling-key collision check for the inline field editor (independent of
 *  the reducer's own uniqueness pass, which only runs on COMMITTED trees —
 *  this checks a DRAFT key before it's dispatched). */
export function siblingKeyTaken(tree: EditorTree, node: FieldNode, key: string): boolean {
  if (node.parentId == null) return false;
  const siblings = tree.childIds[node.parentId] ?? [];
  return siblings.some((id) => id !== node.id && tree.nodes[id]?.key === key);
}

/**
 * Delete-row decision: SHIFT+click on the trash icon skips the confirm
 * dialog and deletes immediately; a plain click requires confirmation.
 * Pulled out as a pure predicate (rather than inlined in the click handler)
 * so the "shift bypasses confirm" contract has a direct unit test instead
 * of depending on rendering the row.
 */
export function shouldSkipDeleteConfirm(event: { shiftKey: boolean }): boolean {
  return event.shiftKey === true;
}
