import type { ComponentType } from 'react';
import { CopyButtonShowcase } from './CopyButtonShowcase';
import { ConfirmDialogShowcase } from './ConfirmDialogShowcase';
import { ToastShowcase } from './ToastShowcase';
import { VirtualListShowcase } from './VirtualListShowcase';
import { DocumentPreviewShowcase } from './DocumentPreviewShowcase';
import { DocumentEditorShowcase } from './DocumentEditorShowcase';
import { CollectionListShowcase } from './CollectionListShowcase';
import { DocumentListShowcase } from './DocumentListShowcase';
import { ReferencePickerShowcase } from './ReferencePickerShowcase';
import { QueryBuilderShowcase } from './QueryBuilderShowcase';
import { TrafficShowcase } from './TrafficShowcase';

export interface ShowcaseEntry {
  id: string;
  title: string;
  blurb: string;
  Component: ComponentType;
}

export interface ShowcaseSection {
  id: string;
  title: string;
  entries: ShowcaseEntry[];
}

export const SECTIONS: ShowcaseSection[] = [
  {
    id: 'primitives',
    title: 'Primitives',
    entries: [
      {
        id: 'copy-button',
        title: 'CopyButton',
        blurb: 'Headless clipboard button. Exposes data-copied for styling.',
        Component: CopyButtonShowcase,
      },
      {
        id: 'confirm-dialog',
        title: 'ConfirmDialog',
        blurb: 'Imperative confirm via useConfirm + ConfirmProvider.',
        Component: ConfirmDialogShowcase,
      },
      {
        id: 'toast',
        title: 'Toast',
        blurb: 'Imperative queue via useToast + ToastProvider.',
        Component: ToastShowcase,
      },
      {
        id: 'virtual-list',
        title: 'VirtualList',
        blurb: 'TanStack-Virtual wrapper. Renders 10k+ rows without DOM bloat.',
        Component: VirtualListShowcase,
      },
    ],
  },
  {
    id: 'read',
    title: 'Read',
    entries: [
      {
        id: 'document-preview',
        title: 'DocumentPreview',
        blurb: 'Read-only field rendering with the per-type editor registry.',
        Component: DocumentPreviewShowcase,
      },
    ],
  },
  {
    id: 'edit',
    title: 'Edit',
    entries: [
      {
        id: 'document-editor',
        title: 'DocumentEditor',
        blurb: 'Reducer-backed editor with pessimistic-save validity gating.',
        Component: DocumentEditorShowcase,
      },
    ],
  },
  {
    id: 'admin',
    title: 'Admin',
    entries: [
      {
        id: 'collection-list',
        title: 'CollectionList',
        blurb: 'Headless list renderer for collections under a parent.',
        Component: CollectionListShowcase,
      },
      {
        id: 'document-list',
        title: 'DocumentList',
        blurb: 'Cursor-paginated list renderer with optional Load More.',
        Component: DocumentListShowcase,
      },
    ],
  },
  {
    id: 'refs',
    title: 'References',
    entries: [
      {
        id: 'reference-picker',
        title: 'ReferencePicker',
        blurb: 'Type or browse to pick a DocumentReference.',
        Component: ReferencePickerShowcase,
      },
    ],
  },
  {
    id: 'query',
    title: 'Query',
    entries: [
      {
        id: 'query-builder',
        title: 'QueryBuilder',
        blurb: 'Single-level where/orderBy/limit builder; composes to a Firestore Query.',
        Component: QueryBuilderShowcase,
      },
    ],
  },
  {
    id: 'traffic',
    title: 'Traffic',
    entries: [
      {
        id: 'traffic-monitor',
        title: 'Traffic Monitor',
        blurb:
          'Rule-eval traffic — live log, drill-in detail, rule heatmap, and stats.',
        Component: TrafficShowcase,
      },
    ],
  },
];

export const ALL_ENTRIES: ShowcaseEntry[] = SECTIONS.flatMap((s) => s.entries);

export function findEntry(id: string | null): ShowcaseEntry {
  if (!id) return ALL_ENTRIES[0];
  return ALL_ENTRIES.find((e) => e.id === id) ?? ALL_ENTRIES[0];
}
