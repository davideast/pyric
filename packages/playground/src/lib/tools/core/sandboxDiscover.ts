/**
 * `sandbox_discover_paths` — discover the shape of the in-browser
 * simulator's data without sign-in, OAuth, or a real Firebase project.
 *
 * The playground's natural surface is the sandbox; this is what the agent
 * should reach for when the user asks about "my data" in playground context.
 *
 * Composition:
 *   - `createSandboxCrawlerFirestore` adapts `SandboxRunner.readState()`
 *     to the structural `CrawlerFirestore` contract the crawler
 *     consumes.
 *   - `createFirestoreDiscoverTools({ resolveDb })` returns a credential-free
 *     ToolHandler pair. We retain the crawl handler under the explicit
 *     `sandbox_discover_paths` name; collection-group lookup remains a library
 *     helper rather than a Playground tool.
 */
import type { ToolHandler } from '@inbrowser/agent';
import {
  createFirestoreDiscoverTools,
  type DiscoverPathsToolResult,
} from '@pyric/cli/discover';
import { createSandboxCrawlerFirestore } from '~/lib/sandbox/crawler-firestore';
import { readFirestoreState } from '~/lib/sandbox/runtime';

export function buildSandboxDiscoverHandler(): ToolHandler {
  return {
    name: 'sandbox_discover_paths',
    parallelSafe: true, // read-only (0.2.0 parallelDispatch)
    parameters: { type: 'object', properties: {} }, // takes no arguments
    description:
      "Discover the shape of the IN-BROWSER SANDBOX'S Firestore data. Returns per-collection schemas (field types, sampling info, subcollection paths) for every collection currently in the simulator. " +
      'Use this when the user asks about "my data", "what collections do I have", "show me my schema", or before generating rules/code that needs to know the shape of the data. ' +
      'This reads only the sandbox state populated by prior `runOnce` calls or by your `writeCode` seeds. If the sandbox is empty (no `runOnce` has populated it yet), the result will be empty; in that case write+run a seed first.',
    async execute(args, ctx) {
      const snapshot = await readFirestoreState();
      const firestore = createSandboxCrawlerFirestore(() => snapshot);
      // The sandbox crawler-firestore satisfies the structural
      // `CrawlerFirestore` subset `createFirestoreDiscoverTools` uses. The
      // `collectionGroup` method is also present (sandbox-backed), so the
      // shape line up cleanly — no admin-only methods are reachable.
      const tools = createFirestoreDiscoverTools({
        resolveDb: () => firestore as never,
      });
      const discover = tools.find((t) => t.name === 'firestore_discover_paths');
      if (!discover) {
        throw new Error(
          'sandbox_discover_paths: credential-free discovery handler is unavailable.',
        );
      }
      const result = await discover.execute(args, ctx);
      if (result.ok) return { ...result, data: trimDiscoverResult(result.data) };
      return result;
    },
  };
}

/** Structural schema retained after removing samples and large map payloads. */
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

export interface TrimmedDiscoverResult {
  schemas: Record<string, TrimmedCollectionSchema>;
  listOps: number;
  readOps: number;
  complete: boolean;
  eventCount: number;
  continuation?: string;
  dryRunCostEstimate?: DiscoverPathsToolResult['dryRunCostEstimate'];
}

const MAX_MAP_FIELDS = 25;
const MAX_NEST_DEPTH = 4;

/**
 * Keep the schema facts the agent needs while dropping per-document samples,
 * enum values, and high-cardinality map expansions from its context window.
 */
export function trimDiscoverResult(data: unknown): TrimmedDiscoverResult | unknown {
  if (!data || typeof data !== 'object') return data;
  const result = data as DiscoverPathsToolResult;
  const trimmed: TrimmedDiscoverResult = {
    schemas: thinSchemas(result.schemas),
    listOps: result.listOps,
    readOps: result.readOps,
    complete: result.complete,
    eventCount: Array.isArray(result.events) ? result.events.length : 0,
  };
  if (result.continuation !== undefined) trimmed.continuation = result.continuation;
  if (result.dryRunCostEstimate !== undefined) {
    trimmed.dryRunCostEstimate = result.dryRunCostEstimate;
  }
  return trimmed;
}

function thinSchemas(
  schemas: DiscoverPathsToolResult['schemas'] | undefined,
): Record<string, TrimmedCollectionSchema> {
  if (!schemas) return {};
  const out: Record<string, TrimmedCollectionSchema> = {};
  for (const [templatePath, collection] of Object.entries(schemas)) {
    const schema = collection.schema as unknown as Record<string, unknown>;
    out[templatePath] = {
      templatePath: collection.templatePath,
      examplePath: collection.examplePath,
      schema: {
        fields: thinFields(
          (schema.fields as Record<string, Record<string, unknown>>) ?? {},
          0,
        ),
        samplesSeen: typeof schema.samplesSeen === 'number' ? schema.samplesSeen : 0,
      },
      samplingComplete: collection.samplingComplete,
      subcollectionTemplatePaths: collection.subcollectionTemplatePaths,
    };
  }
  return out;
}

function thinFields(
  fields: Record<string, Record<string, unknown>>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    out[name] = thinFieldDescriptor(field, depth);
  }
  return out;
}

function thinFieldDescriptor(
  field: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const types = Array.isArray(field.types)
    ? (field.types as Record<string, unknown>[])
    : [];
  return {
    types: types.map((type) => thinFieldType(type, depth)),
    presenceSeen: field.presenceSeen,
    presenceTotal: field.presenceTotal,
    nullable: field.nullable,
    ...(field.enumCandidate && typeof field.enumCandidate === 'object'
      ? {
          enumCandidate: {
            qualifies: (field.enumCandidate as { qualifies?: boolean }).qualifies,
          },
        }
      : {}),
  };
}

function thinFieldType(
  type: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  if (type.kind === 'map') {
    const fields = (type.fields as Record<string, Record<string, unknown>>) ?? {};
    const keys = Object.keys(fields);
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
  if (type.kind === 'array') {
    const elementTypes = Array.isArray(type.elementTypes)
      ? (type.elementTypes as Record<string, unknown>[])
      : [];
    return {
      kind: 'array',
      elementTypes: elementTypes.map((element) => thinFieldType(element, depth + 1)),
    };
  }
  return type;
}
