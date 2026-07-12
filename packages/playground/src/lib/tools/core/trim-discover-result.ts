import type { DiscoverPathsToolResult } from '@pyric/cli/internal/discover';

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
