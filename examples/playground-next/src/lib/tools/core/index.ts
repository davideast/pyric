/**
 * Core tool manifest. Always registered — the file-based authoring
 * surface (read/write/list/delete) plus the sandbox-discovery and
 * Firestore-rules helpers the agent needs by default.
 *
 * Diagnostic tools (denials surfacing, simulator inspection, etc.)
 * live under `../diagnostics/` and gate on the user's
 * `pyricDiagnosticsEnabled` toggle.
 *
 * The historical interpreter wrappers (writeRules/writeCode/writeApp/
 * runOnce) were retired when the agent loop moved to file tools +
 * diagnostic primitives. See `src/lib/sandbox/runner.ts` for the
 * remaining sandbox surface.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { deleteFileHandler } from './deleteFile';
import { editFileHandler } from './editFile';
import { listFilesHandler } from './listFiles';
import { readFileHandler } from './readFile';
import { searchFileHandler } from './searchFile';
import { writeFileHandler } from './writeFile';
import { buildSandboxDiscoverHandler } from './sandboxDiscover';
import { buildFirestoreExtractIndexesHandler } from './firestoreExtractIndexes';
import { buildFirestoreRulesStdlibHandlers } from './firestoreRulesStdlib';
import { inspectDenialHandler } from './inspectDenial';

import { runWorkspaceTestsHandler } from './runWorkspaceTests';
import { bashHandler } from './bash';

export const CORE_TOOLS: readonly ToolHandler[] = [
  // File-based authoring surface, paths under /workspace/.
  listFilesHandler as ToolHandler,
  searchFileHandler as ToolHandler,
  readFileHandler as ToolHandler,
  editFileHandler as ToolHandler,
  writeFileHandler as ToolHandler,
  deleteFileHandler as ToolHandler,
  // Sandbox + static-analysis helpers.
  buildSandboxDiscoverHandler(),
  buildFirestoreExtractIndexesHandler(),
  ...buildFirestoreRulesStdlibHandlers(),
  inspectDenialHandler,
  // W1 dev loop: one call runs the whole /workspace/tests suite.
  runWorkspaceTestsHandler as ToolHandler,
  // W2.1 bash action surface: persistent workspace shell + builtins.
  bashHandler as ToolHandler,
];
