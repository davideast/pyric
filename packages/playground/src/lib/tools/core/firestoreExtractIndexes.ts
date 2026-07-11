/**
 * `firestore_extract_indexes` — static analysis on the workspace's
 * JS/TS editor bodies (or explicit `files` the agent passes).
 *
 * Goes in CORE (always registered) because the extractor is a pure
 * AST pass — no auth, no network, no sign-in. The playground wraps
 * the SDK's `createFirestoreIndexesExtractTools()` factory and adds
 * one ergonomic affordance: if the agent calls with no `files`, the
 * wrapper auto-supplies the `code` and `appSource` bodies from
 * `useWorkspaceStore`. That matches the most common intent — "what
 * indexes does the code I'm editing need?" — without making the
 * agent shuttle the editor body through its args every time.
 *
 * The agent CAN still pass `files` explicitly to scan something
 * else (e.g. a snippet it just generated but hasn't written yet).
 */
import type { ToolHandler } from '@inbrowser/agent';
import { createFirestoreExtractTool } from 'pyric/rules/internal/extract';
import { useWorkspaceStore } from '~/lib/store/workspace';

interface ExtractArgs {
  files?: Array<{ name: string; source: string }>;
  queryVarName?: string;
}

export function buildFirestoreExtractIndexesHandler(): ToolHandler {
  const extract = createFirestoreExtractTool();
  const inner = extract.execute;
  return {
    ...extract,
    description:
      "Statically extract Firestore composite-index requirements from JS/TS source. " +
      "If you don't pass `files`, the workspace's current Code editor body (and the App editor body if non-empty) is scanned automatically — useful right after `writeCode`/`writeApp` to see what indexes the draft would need. " +
      "Pass `files` explicitly to scan a snippet you have NOT written into the editor yet. " +
      "Returns: `config` (firestore.indexes.json-shaped — drop into firestore_deploy_indexes), per-collection `signals` (overshootSuspected = enumerated shapes > 3 → cue to add JSDoc `@firestore-mutex { a, b }` on the function), `annotationsApplied`, and per-file `warnings`. " +
      "SYNTAX REQUIREMENTS: the extractor recognizes the modular Firebase Web SDK wrap pattern (`const q = query(collection(db, 'X'), where(...), orderBy(...))`) INSIDE a function body. The playground sandbox is modular as of recent changes, so writing normal modular code inside a named `async function` (or arrow IIFE) is what works. It does NOT recognize admin-chain syntax (`db.collection().where()...`) or top-level statements outside any function — those return `shapesEnumerated: 0`. " +
      "IF SHAPES IS 0: do NOT fabricate an index list. Tell the user the extractor matched nothing, name the most-likely reason (admin-chain syntax, top-level code, or no query patterns at all), and suggest the modular-inside-a-function shape. Issue tracked: SDK should also recognize admin-chain.",
    // Loosen `files` to optional in the agent-facing schema. The SDK
    // tool's inner contract still requires non-empty; the wrapper
    // fills it in from the workspace below.
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Optional inline source files. If omitted, defaults to your current Code editor body + App editor body.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'File name for diagnostics.' },
              source: { type: 'string', description: 'JS/TS source to scan.' },
            },
            required: ['name', 'source'],
          },
        },
        queryVarName: {
          type: 'string',
          description: 'Variable name the extractor walks for the wrap pattern. Defaults to "q".',
        },
      },
    } as ToolHandler['parameters'],
    async execute(args, ctx) {
      const a = (args ?? {}) as ExtractArgs;
      let files = a.files;
      if (!files || files.length === 0) {
        const ws = useWorkspaceStore.getState();
        files = [];
        if (ws.appSource.trim()) files.push({ name: 'app.tsx', source: ws.appSource });
      }
      if (files.length === 0) {
        return {
          ok: false,
          summary:
            'firestore_extract_indexes · no source to scan (editors empty and no `files` passed). Write some code first, or pass files explicitly.',
          data: { reason: 'no_source' },
        };
      }
      return inner({ ...a, files }, ctx);
    },
  };
}
