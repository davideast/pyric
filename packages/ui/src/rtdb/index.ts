/**
 * `@pyric/ui/rtdb` — the headless RTDB data viewer, in the Firebase console /
 * firebase-tools-ui form: an editable path bar (crumbs + direct path entry)
 * over an expandable tree with inline add/edit/delete affordances. Follows
 * this package's firestore/auth/storage split: pure logic + hooks +
 * unstyled components on `data-*` styling contracts; the consumer (Studio)
 * brings the CSS and the backend bundle ({@link RtdbApi}).
 */

// Pure path + value helpers.
export {
  normalizeRtdbPath,
  rtdbPathSegments,
  joinRtdbPath,
  parentRtdbPath,
  relativeRtdbPath,
  isRtdbObjectValue,
  hasRtdbChildren,
  rtdbChildEntries,
  rtdbValueAt,
  formatRtdbJson,
  parseRtdbJson,
  rtdbValueKind,
  previewRtdbValue,
} from './values.js';

// Path-bar input parsing + crumb derivation.
export { parseRtdbPathInput, rtdbCrumbs, type RtdbCrumb } from './pathInput.js';

// Inline value-editor logic.
export {
  RTDB_EDITOR_TYPES,
  inferRtdbEditorType,
  formatRtdbEditorValue,
  coerceRtdbEditorValue,
  rtdbKeyInputError,
  type RtdbEditorType,
  type RtdbEditorResult,
} from './editor.js';

// Backend seam.
export type { RtdbApi } from './rtdbApi.js';

// Tree state (pure reducer + selectors).
export {
  initialRtdbTree,
  rtdbTreeReducer,
  rtdbTreeValueAt,
  isRtdbPathExpanded,
  rtdbVisibleChildren,
  type RtdbTreeState,
  type RtdbTreeAction,
  type RtdbVisibleChildren,
} from './reducers/tree.js';

// Hook + components.
export {
  useRtdbTree,
  RTDB_DEFAULT_PAGE_SIZE,
  type UseRtdbTreeOptions,
  type RtdbTreeController,
} from './hooks/useRtdbTree.js';
export { RtdbPathBar, type RtdbPathBarProps } from './components/RtdbPathBar.js';
export { RtdbTree, type RtdbTreeProps } from './components/RtdbTree.js';
