export * from './hooks/index.js';

// Injectable Firestore API bundle (Pyric Studio data-backend swap): defaults to
// in-process `pyric/firestore`; a consumer can provide the SharedWorker client.
export {
  FirestoreApiProvider,
  useFirestoreApi,
  type FirestoreApi,
} from './firestoreApi.js';

// M2: read-only display surface
export {
  inferType,
  asVectorView,
  vectorPreview,
  truncateVectorsForDisplay,
  type FieldType,
  type VectorView,
} from './types.js';
export { firestoreValuesEqual } from './valueEquality.js';
export {
  defaultFieldEditors,
  mergeFieldEditors,
} from './fieldEditors/registry.js';
export type {
  FieldEditorContract,
  FieldEditorRegistry,
  FieldDisplayProps,
  FieldEditProps,
} from './fieldEditors/types.js';
export { FieldRenderer, type FieldRendererProps } from './components/FieldRenderer.js';
export {
  DocumentPreview,
  type DocumentPreviewProps,
} from './components/DocumentPreview.js';

// M3: editor surface
export type {
  FieldNode,
  EditorTree,
  DocumentEditorAction,
  DocumentEditorState,
} from './reducers/types.js';
export { validateLeaf, validateTree } from './reducers/validation.js';
export { treeFromData, treeToData } from './reducers/tree.js';
export { initState, reducer } from './reducers/documentEditor.js';
export {
  DocumentEditor,
  DocumentEditorRoot,
  DocumentEditorFields,
  useDocumentEditorContext,
  type DocumentEditorRootProps,
} from './components/DocumentEditor.js';

// M4: operational read/write + admin ops
export { CollectionList, type CollectionListProps } from './components/CollectionList.js';
export { DocumentList, type DocumentListProps } from './components/DocumentList.js';
export {
  DeleteWithConfirm,
  type DeleteWithConfirmProps,
} from './components/DeleteWithConfirm.js';

// M5: improvements over firebase-tools-ui
export {
  ReferencePicker,
  type ReferencePickerProps,
} from './components/ReferencePicker.js';

// M6: query builder + virtualization
export {
  QueryBuilder,
  type QueryBuilderProps,
} from './components/QueryBuilder.js';

// M7: create-collection / create-document / JSON-import — pure, tested logic.
// Presentational wiring lives in the consumer (Pyric Studio's FirestorePane)
// over these + the existing DocumentEditor/hooks, per the disclosure-over-
// modals design principles.
export { validateCollectionId, validateDocumentId } from './validation/ids.js';
export {
  parseImport,
  detectCollisions,
  firestoreAutoId,
  type ParsedImportDoc,
  type ParseImportResult,
  type ParseImportOptions,
} from './import/parseImport.js';
