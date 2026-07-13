/**
 * `firestore_discover_paths` + `firestore_find_collection_group`
 * registered against the user's signed-in Firebase project.
 *
 * Built on the browser `AgentApp` shim — `createBrowserAgentApp`
 * gives us a REST-backed `CrawlerFirestore` that the canonical
 * `createFirestoreDiscoverTools({ resolveDb })` factory from
 * `@pyric/firestore/discover` consumes. Returns ToolHandlers
 * directly; no AgentTool → ToolHandler adapter needed.
 *
 * Results are returned IN-TURN only — nothing is cached or persisted.
 * The agent re-calls the tool when it needs fresh project structure.
 *
 * Registration gate (see `index.ts`): tools are NOT created at all
 * unless the user is signed in AND has picked a Firebase project
 * AND `pyricDiagnosticsEnabled` is true. So when any of those is
 * false the registry simply doesn't contain these tools — the
 * agent never sees their declarations.
 */
import {
  createFirestoreDiscoverTools,
  type DiscoverPathsToolResult,
} from '@pyric/cli/discover';
import { createRestCrawlerFirestore } from '@pyric/cli/discover/production';
import type { ToolContext, ToolHandler, ToolResult } from '@inbrowser/agent';

/**
 * Trimmed per-collection schema as returned in the tool result. This is
 * the shape `trimDiscoverResult` produces — NOT the SDK's full
 * `CollectionSchema`. The raw schema carries per-field `example` values
 * and fully-expanded nested maps that routinely run a production crawl
 * into the hundreds-of-thousands of tokens; the LLM context can't hold
 * that. The trimmed shape keeps field names + types + presence + a
 * `qualifies` enum flag — enough for type generation — and collapses
 * high-cardinality nested maps to a `{ keyCount, sampleKeys }` summary.
 */
export interface TrimmedCollectionSchema {
  templatePath: string;
  examplePath?: string;
  schema: {
    fields: Record<string, unknown>;
    samplesSeen: number;
  };
  samplingComplete: string;
  subcollectionTemplatePaths: string[];
}

export interface DiscoverHandlerOptions {
  accessToken: string;
  projectId: string;
}

export function buildFirestoreDiscoverHandlers(
  opts: DiscoverHandlerOptions,
): ToolHandler[] {
  const db = createRestCrawlerFirestore({
    accessToken: opts.accessToken,
    projectId: opts.projectId,
  });
  const handlers = createFirestoreDiscoverTools({
    resolveDb: () => db as never,
  });
  return handlers.map((tool): ToolHandler => {
    if (tool.name !== 'firestore_discover_paths') return tool;
    const inner = tool.execute;
    return {
      ...tool,
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const result = await inner(clampDiscoverArgs(args), ctx);
        if (!result.ok) return result;
        // Trim the result. The raw result can be hundreds of
        // thousands of tokens on a production database — the
        // per-sample `events` array, plus per-field examples, plus
        // (the real killer) nested map-typed fields that expand
        // every map KEY into its own descriptor (config docs that
        // use maps as dictionaries — move tables, lookup tables —
        // blow up to thousands of nested fields). `trimDiscoverResult`
        // strips events + examples + enum values and collapses
        // high-cardinality nested maps to a `{ keyCount, sampleKeys }`
        // summary before the result enters the LLM context.
        const trimmed = trimDiscoverResult(result.data) as TrimmedDiscoverResult;
        return { ...result, data: trimmed };
      },
    };
  });
}

/**
 * Clamp the agent-supplied args to safe-by-default sampling caps. The
 * SDK defaults (`maxSamples: 50`, `stopOnStable: 8`) are tuned for
 * server-side use; in a browser the result has to flow back through a
 * LLM context window and render in the activity drawer, both of which
 * choke on large production databases. We force-narrow unless the
 * agent explicitly asks for more.
 *
 * Agent can still go bigger by passing explicit values — we only
 * substitute when the arg is missing. The cap on what's passed
 * through is enforced via the `Math.min` below.
 */
function clampDiscoverArgs(args: unknown): unknown {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...a };
  // Default sampling caps — much smaller than the SDK's defaults.
  if (out.maxSamples === undefined) out.maxSamples = 5;
  if (out.stopOnStable === undefined) out.stopOnStable = 3;
  // Hard ceiling. The agent CAN raise these but not above the cap —
  // anything higher means the result will overrun the context window.
  if (typeof out.maxSamples === 'number') out.maxSamples = Math.min(out.maxSamples, 20);
  if (typeof out.stopOnStable === 'number') out.stopOnStable = Math.min(out.stopOnStable, 10);
  return out;
}

/** When a map-typed field has more nested fields than this, collapse
 *  it to a `{ keyCount, sampleKeys }` summary. Config docs that use
 *  maps as dictionaries (move tables, position lookups) routinely
 *  carry thousands of keys; expanding each into a descriptor is what
 *  drives the result into the hundreds-of-thousands-of-tokens range. */
const MAX_MAP_FIELDS = 25;
/** Hard recursion cap on nested map/array descent. Past this depth
 *  the descriptor is collapsed regardless of breadth — runaway-nesting
 *  guard for self-referential or deeply-nested config shapes. */
const MAX_NEST_DEPTH = 4;

export interface TrimmedDiscoverResult {
  schemas: Record<string, TrimmedCollectionSchema>;
  listOps: number;
  readOps: number;
  complete: boolean;
  eventCount: number;
  continuation?: string;
  dryRunCostEstimate?: DiscoverPathsToolResult['dryRunCostEstimate'];
}

/**
 * Strip a discover result down to a structural skeleton the agent can
 * reason over without overrunning the context window:
 *   - drop the per-sample `events` array (keep just `eventCount`)
 *   - drop per-field `example` values (can be whole nested docs)
 *   - drop `enumCandidate.values` (keep `qualifies` so the agent
 *     still knows the field is enum-shaped)
 *   - collapse map-typed fields with > MAX_MAP_FIELDS nested keys to
 *     a `{ kind: 'map', keyCount, sampleKeys, collapsed: true }`
 *     summary, recursively, with a MAX_NEST_DEPTH guard
 *
 * Field names + types + presence survive — enough for TypeScript type
 * generation, which is the primary use case.
 */
export function trimDiscoverResult(data: unknown): TrimmedDiscoverResult | unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as DiscoverPathsToolResult;
  const eventCount = Array.isArray(d.events) ? d.events.length : 0;
  const trimmed: TrimmedDiscoverResult = {
    schemas: thinSchemas(d.schemas),
    listOps: d.listOps,
    readOps: d.readOps,
    complete: d.complete,
    eventCount,
  };
  if (d.continuation !== undefined) trimmed.continuation = d.continuation;
  if (d.dryRunCostEstimate !== undefined) trimmed.dryRunCostEstimate = d.dryRunCostEstimate;
  return trimmed;
}

function thinSchemas(
  schemas: DiscoverPathsToolResult['schemas'] | undefined,
): Record<string, TrimmedCollectionSchema> {
  if (!schemas) return {};
  const out: Record<string, TrimmedCollectionSchema> = {};
  for (const [templatePath, s] of Object.entries(schemas)) {
    const raw = s.schema as unknown as Record<string, unknown>;
    out[templatePath] = {
      templatePath: s.templatePath,
      examplePath: s.examplePath,
      schema: {
        fields: thinFields(
          (raw?.fields as Record<string, Record<string, unknown>>) ?? {},
          0,
        ),
        samplesSeen: typeof raw?.samplesSeen === 'number' ? raw.samplesSeen : 0,
      },
      samplingComplete: s.samplingComplete,
      subcollectionTemplatePaths: s.subcollectionTemplatePaths,
    };
  }
  return out;
}

function thinFields(
  fields: Record<string, Record<string, unknown>>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(fields)) {
    out[name] = thinFieldDescriptor(f, depth);
  }
  return out;
}

function thinFieldDescriptor(
  f: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const types = Array.isArray(f.types) ? (f.types as Record<string, unknown>[]) : [];
  return {
    types: types.map((t) => thinFieldType(t, depth)),
    presenceSeen: f.presenceSeen,
    presenceTotal: f.presenceTotal,
    nullable: f.nullable,
    // Keep `enumCandidate.qualifies` so the agent knows the field is
    // enum-shaped; drop the `values` list (up to `threshold` strings).
    ...(f.enumCandidate && typeof f.enumCandidate === 'object'
      ? {
          enumCandidate: {
            qualifies: (f.enumCandidate as { qualifies?: boolean }).qualifies,
          },
        }
      : {}),
  };
}

function thinFieldType(
  t: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  if (t?.kind === 'map') {
    const fields = (t.fields as Record<string, Record<string, unknown>>) ?? {};
    const keys = Object.keys(fields);
    // Collapse high-cardinality OR too-deeply-nested maps. The summary
    // tells the agent it's a dictionary-shaped map and roughly how big,
    // without enumerating every key.
    if (depth >= MAX_NEST_DEPTH || keys.length > MAX_MAP_FIELDS) {
      return {
        kind: 'map',
        keyCount: keys.length,
        sampleKeys: keys.slice(0, 5),
        collapsed: true,
      };
    }
    return { kind: 'map', fields: thinFields(fields, depth + 1) };
  }
  if (t?.kind === 'array') {
    const elementTypes = Array.isArray(t.elementTypes)
      ? (t.elementTypes as Record<string, unknown>[])
      : [];
    return {
      kind: 'array',
      elementTypes: elementTypes.map((et) => thinFieldType(et, depth + 1)),
    };
  }
  // scalar / reference / vector — already small, pass through.
  return t;
}
