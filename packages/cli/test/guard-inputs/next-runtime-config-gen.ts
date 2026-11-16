/**
 * Equivalence-class grammar and specification predicate for Next.js segment
 * `runtime` x `config` (`config.runtime`) export combinations across App routes,
 * Pages API routes, `middleware.ts`, and `proxy.ts`.
 */
import { cartesian2, cartesian3 } from './combinators.js';

type NextTargetKind = 'app-route' | 'pages-api' | 'middleware' | 'proxy';
type RuntimeSemantic = 'absent' | 'nodejs' | 'edge' | 'indeterminate';

interface RuntimeExportForm {
  readonly id: string;
  readonly semantic: RuntimeSemantic;
  readonly preamble: string;
  readonly statement: string;
}

interface ConfigExportForm {
  readonly id: string;
  readonly semantic: RuntimeSemantic;
  readonly preamble: string;
  readonly statement: string;
}

export interface GeneratedNextModuleCase {
  readonly id: string;
  readonly relativePath: string;
  readonly source: string;
  readonly expectedFlagged: boolean;
}

export const SEGMENT_RUNTIME_MODULE_PATH = 'config/runtimes.ts';
export const SEGMENT_RUNTIME_MODULE_SOURCE = [
  "export const SEGMENT_EDGE = 'edge' as const;",
  "export const SEGMENT_NODE = 'nodejs' as const;",
  "export const SEGMENT_EDGE_CONFIG = { runtime: 'experimental-edge' } as const;",
  '',
].join('\n');

const RUNTIME_EXPORT_FORMS: readonly RuntimeExportForm[] = [
  {
    id: 'rt-none',
    semantic: 'absent',
    preamble: '',
    statement: '',
  },
  {
    id: 'rt-node-literal',
    semantic: 'nodejs',
    preamble: '',
    statement: "export const runtime = 'nodejs';",
  },
  {
    id: 'rt-node-reexport',
    semantic: 'nodejs',
    preamble: "import { SEGMENT_NODE } from '@/config/runtimes';",
    statement: 'export { SEGMENT_NODE as runtime };',
  },
  {
    id: 'rt-edge-literal',
    semantic: 'edge',
    preamble: '',
    statement: "export const runtime = 'edge';",
  },
  {
    id: 'rt-exp-edge-literal',
    semantic: 'edge',
    preamble: '',
    statement: "export const runtime = 'experimental-edge';",
  },
  {
    id: 'rt-edge-reexport',
    semantic: 'edge',
    preamble: '',
    statement: "export { SEGMENT_EDGE as runtime } from '@/config/runtimes';",
  },
  {
    id: 'rt-array-destructure',
    semantic: 'indeterminate',
    preamble: '',
    statement: "export const [runtime] = ['edge'];",
  },
  {
    id: 'rt-mutable-let',
    semantic: 'indeterminate',
    preamble: "let mutableRuntime = 'nodejs';\nmutableRuntime = 'edge';",
    statement: 'export { mutableRuntime as runtime };',
  },
  {
    id: 'rt-default-destructure',
    semantic: 'indeterminate',
    preamble: 'const emptyHolder: { runtime?: string } = {};',
    statement: "export const { runtime = 'edge' } = emptyHolder;",
  },
];

const CONFIG_EXPORT_FORMS: readonly ConfigExportForm[] = [
  {
    id: 'cfg-none',
    semantic: 'absent',
    preamble: '',
    statement: '',
  },
  {
    id: 'cfg-node-literal',
    semantic: 'nodejs',
    preamble: '',
    statement: "export const config = { runtime: 'nodejs' };",
  },
  {
    id: 'cfg-lead-spread-node',
    semantic: 'nodejs',
    preamble: 'declare const leadingExtra: Record<string, string>;',
    statement: "export const config = { ...leadingExtra, runtime: 'nodejs' };",
  },
  {
    id: 'cfg-node-safe-spread',
    semantic: 'nodejs',
    preamble: 'const safeDefaults = { api: { bodyParser: false } };',
    statement: "export const config = { runtime: 'nodejs', ...safeDefaults };",
  },
  {
    id: 'cfg-edge-literal',
    semantic: 'edge',
    preamble: '',
    statement: "export const config = { runtime: 'edge' };",
  },
  {
    id: 'cfg-exp-edge-reexport',
    semantic: 'edge',
    preamble: '',
    statement: "export { SEGMENT_EDGE_CONFIG as config } from '@/config/runtimes';",
  },
  {
    id: 'cfg-getter',
    semantic: 'indeterminate',
    preamble: '',
    statement: "export const config = { get runtime() { return 'edge'; } };",
  },
  {
    id: 'cfg-method',
    semantic: 'indeterminate',
    preamble: '',
    statement: "export const config = { runtime() { return 'edge'; } };",
  },
  {
    id: 'cfg-object-rest',
    semantic: 'indeterminate',
    preamble: "const rawSegmentConfig = { runtime: 'edge' };",
    statement: 'export const { ...config } = rawSegmentConfig;',
  },
  {
    id: 'cfg-trailing-spread',
    semantic: 'indeterminate',
    preamble: 'declare const dynamicTrailing: Record<string, string>;',
    statement: "export const config = { runtime: 'nodejs', ...dynamicTrailing };",
  },
  {
    id: 'cfg-trailing-computed',
    semantic: 'indeterminate',
    preamble: "const computedKey = 'run' + 'time';",
    statement: "export const config = { runtime: 'nodejs', [computedKey]: 'edge' };",
  },
];

function isEdgeOrIndeterminate(semantic: RuntimeSemantic): boolean {
  return semantic === 'edge' || semantic === 'indeterminate';
}

/**
 * Independent ground-truth specification predicate for whether Next.js segment
 * config exports run on (or cannot be statically proven free of) Edge runtime:
 * - Route/API/proxy files default to Node, so they require an Edge stop iff
 *   either `runtime` or `config.runtime` is `edge` or `indeterminate`.
 * - Middleware defaults to Edge in Next.js, so it requires an Edge stop unless
 *   neither declaration is `edge`/`indeterminate` AND at least one declaration
 *   explicitly opts into `nodejs`.
 */
function isExpectedEdgeStop(
  targetKind: NextTargetKind,
  runtimeSemantic: RuntimeSemantic,
  configSemantic: RuntimeSemantic,
): boolean {
  const hasUnsafeDeclaration =
    isEdgeOrIndeterminate(runtimeSemantic) || isEdgeOrIndeterminate(configSemantic);
  if (targetKind === 'middleware') {
    if (hasUnsafeDeclaration) return true;
    return runtimeSemantic !== 'nodejs' && configSemantic !== 'nodejs';
  }
  return hasUnsafeDeclaration;
}

function buildHandlerLine(targetKind: NextTargetKind): string {
  if (targetKind === 'app-route') {
    return "export function GET() { return new Response('items'); }";
  }
  if (targetKind === 'pages-api') {
    return 'export default function handler() { return null; }';
  }
  if (targetKind === 'middleware') {
    return 'export function middleware() { return undefined; }';
  }
  return 'export function proxy() { return undefined; }';
}

function buildRelativePath(targetKind: NextTargetKind, caseId: string): string {
  if (targetKind === 'app-route') return `app/api/${caseId}/route.ts`;
  if (targetKind === 'pages-api') return `pages/api/${caseId}.ts`;
  if (targetKind === 'middleware') return 'middleware.ts';
  return 'proxy.ts';
}

function renderModuleSource(
  targetKind: NextTargetKind,
  rt: RuntimeExportForm,
  cfg: ConfigExportForm,
): string {
  const lines: string[] = [];
  if (rt.preamble !== '') lines.push(rt.preamble);
  if (cfg.preamble !== '') lines.push(cfg.preamble);
  if (rt.statement !== '') lines.push(rt.statement);
  if (cfg.statement !== '') lines.push(cfg.statement);
  lines.push(buildHandlerLine(targetKind));
  lines.push('');
  return lines.join('\n');
}

/**
 * Generates the cartesian product of `app-route` and `pages-api` targets with
 * every `runtime` x `config` export form, suitable for batch evaluation in a
 * single Next.js project tree.
 */
export function generateBatchRouteConfigMatrix(): GeneratedNextModuleCase[] {
  const routeKinds: readonly NextTargetKind[] = ['app-route', 'pages-api'];
  return cartesian3(routeKinds, RUNTIME_EXPORT_FORMS, CONFIG_EXPORT_FORMS).map(
    ([targetKind, rt, cfg]) => {
      const id = `${targetKind}-${rt.id}-${cfg.id}`;
      return {
        id,
        relativePath: buildRelativePath(targetKind, id),
        source: renderModuleSource(targetKind, rt, cfg),
        expectedFlagged: isExpectedEdgeStop(targetKind, rt.semantic, cfg.semantic),
      };
    },
  );
}

/**
 * Generates the cartesian product of `runtime` x `config` export forms for
 * single-entry root files (`middleware.ts` or `proxy.ts`).
 */
export function generateSingleRootConfigMatrix(
  targetKind: 'middleware' | 'proxy',
): GeneratedNextModuleCase[] {
  return cartesian2(RUNTIME_EXPORT_FORMS, CONFIG_EXPORT_FORMS).map(([rt, cfg]) => {
    const id = `${targetKind}-${rt.id}-${cfg.id}`;
    return {
      id,
      relativePath: buildRelativePath(targetKind, id),
      source: renderModuleSource(targetKind, rt, cfg),
      expectedFlagged: isExpectedEdgeStop(targetKind, rt.semantic, cfg.semantic),
    };
  });
}
