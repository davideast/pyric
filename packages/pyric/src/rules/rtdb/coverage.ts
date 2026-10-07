/**
 * Rule coverage for Realtime Database rules.
 *
 * A recorder is built on a compiled ruleset. It lists every `.read`, `.write`,
 * `.validate` and `.indexOn` node, folds in the per-request rule traces the
 * simulation handler returns, and reports for each node whether the run
 * evaluated it and with which outcomes.
 *
 * `.read`, `.write` and `.validate` nodes are evaluated by a request.
 * An `.indexOn` node is used by a read case whose query orders by a child path
 * or by value and whose declared index list names that ordering; a query no
 * node declares an index for is reported under `missingIndexes`.
 */
import type { RtdbNode } from './types.js';
import { nodesDeclaringIndex } from './index-lookup.js';
import { locateRtdbTrace } from './source-locations.js';
import type { RtdbRuleEvaluation, SimulationQuery } from './simulation/spec.js';

export type RtdbCoverageKind = 'read' | 'write' | 'validate' | 'indexOn';

/**
 * - `allow`, `deny`, `error`: every evaluation of the node had that outcome.
 * - `mixed`: the node had more than one of those outcomes.
 * - `unsupported`: the node's expression could not be evaluated, every time.
 * - `never-evaluated`: no request in the run reached the node.
 */
export type RtdbCoverageStatus =
  | 'allow'
  | 'deny'
  | 'error'
  | 'mixed'
  | 'unsupported'
  | 'never-evaluated';

export interface RtdbRuleCoverage {
  /** The rule node's path, such as `/rooms/$roomId`. */
  path: string;
  kind: RtdbCoverageKind;
  /** The rule expression, or the declared index list for `indexOn`. */
  expression: string;
  /** 1-indexed line in the rules file, when a line lookup was supplied. */
  line?: number;
  /** Evaluations that produced a verdict: `allow + deny + error`. */
  evaluated: number;
  allow: number;
  deny: number;
  error: number;
  unsupported: number;
  status: RtdbCoverageStatus;
}

export interface RtdbFileCoverage {
  /** The rules file the nodes came from, or `null` when none was named. */
  file: string | null;
  total: number;
  /** Nodes with at least one evaluation. */
  covered: number;
  neverEvaluated: number;
  /** Nodes the simulator could not evaluate, every time it reached them.
   *  `covered + neverEvaluated + unsupported` is `total`. */
  unsupported: number;
  byKind: Record<RtdbCoverageKind, { total: number; covered: number; unsupported: number }>;
}

export interface RtdbCoverageSummary {
  rules: RtdbRuleCoverage[];
  /** `"<path> .<kind>"` for each node never evaluated, in tree order. */
  uncovered: string[];
  /** Queries that needed an index no loaded node declares. */
  missingIndexes: Array<{ path: string; index: string }>;
  files: RtdbFileCoverage[];
}

export interface RtdbCoverageOptions {
  /** Names the rules file in `files`. */
  file?: string;
  /**
   * The text of `database.rules.json`. Each row gains the 1-indexed `line` of
   * its rule key, located with {@link locateRtdbTrace}. A row whose key the
   * text does not contain, or text that is not valid JSON with comments,
   * leaves `line` unset.
   */
  source?: string;
}

const KINDS: readonly RtdbCoverageKind[] = ['read', 'write', 'validate', 'indexOn'];

interface Counts {
  allow: number;
  deny: number;
  error: number;
  unsupported: number;
}

interface Row {
  path: string;
  kind: RtdbCoverageKind;
  expression: string;
  counts: Counts;
}

function keyOf(path: string, kind: RtdbCoverageKind): string {
  return `${path}\u0000${kind}`;
}

function statusOf(counts: Counts): RtdbCoverageStatus {
  const seen = (['allow', 'deny', 'error'] as const).filter((verdict) => counts[verdict] > 0);
  if (seen.length > 1) return 'mixed';
  if (seen.length === 1) return seen[0];
  return counts.unsupported > 0 ? 'unsupported' : 'never-evaluated';
}

export class RtdbCoverageRecorder {
  private readonly rows = new Map<string, Row>();
  private readonly missing = new Map<string, { path: string; index: string }>();

  constructor(private readonly compiled: RtdbNode) {
    this.collect(compiled);
  }

  private collect(node: RtdbNode): void {
    for (const kind of KINDS) {
      let expression: string | undefined;
      if (kind === 'indexOn') {
        if (node.indexOn !== undefined) expression = JSON.stringify(node.indexOn);
      } else {
        expression = node[kind]?.raw;
      }
      if (expression === undefined) continue;
      this.rows.set(keyOf(node.path, kind), {
        path: node.path,
        kind,
        expression,
        counts: { allow: 0, deny: 0, error: 0, unsupported: 0 },
      });
    }
    for (const child of node.children) this.collect(child);
  }

  /** Folds in the rules one request evaluated. */
  record(trace: readonly RtdbRuleEvaluation[] | undefined): void {
    for (const entry of trace ?? []) {
      const row = this.rows.get(keyOf(entry.path, entry.kind));
      if (row === undefined) continue;
      if (entry.verdict === 'ALLOW') row.counts.allow++;
      else if (entry.verdict === 'DENY') row.counts.deny++;
      else if (entry.verdict === 'ERROR') row.counts.error++;
      else row.counts.unsupported++;
    }
  }

  /**
   * Folds in a read at `path` that carries `query`. A query ordered by child
   * path or by value uses the `.indexOn` nodes at `path` that declare that
   * ordering; when none does, the query is listed under `missingIndexes`.
   * Key ordering and unordered queries use built-in indexes.
   */
  recordQuery(path: string, query: SimulationQuery | undefined): void {
    if (query === undefined) return;
    let required: string | null = null;
    if (query.orderByValue === true) required = '.value';
    else if (typeof query.orderByChild === 'string' && query.orderByChild !== '') {
      required = query.orderByChild.split('/').filter(Boolean).join('/');
    }
    if (required === null) return;
    const segments = path.split('/').filter(Boolean);
    const declaring = nodesDeclaringIndex(this.compiled, segments, required);
    for (const node of declaring) {
      const row = this.rows.get(keyOf(node.path, 'indexOn'));
      if (row !== undefined) row.counts.allow++;
    }
    if (declaring.length === 0) {
      const at = `/${segments.join('/')}`;
      this.missing.set(`${at}\u0000${required}`, { path: at, index: required });
    }
  }

  summarize(options: RtdbCoverageOptions = {}): RtdbCoverageSummary {
    const counted: RtdbRuleCoverage[] = [];
    for (const row of this.rows.values()) {
      const { allow, deny, error, unsupported } = row.counts;
      const entry: RtdbRuleCoverage = {
        path: row.path,
        kind: row.kind,
        expression: row.expression,
        evaluated: allow + deny + error,
        allow,
        deny,
        error,
        unsupported,
        status: statusOf(row.counts),
      };
      counted.push(entry);
    }
    const rules = options.source === undefined ? counted : locateRtdbTrace(options.source, counted);
    const byKind = Object.fromEntries(
      KINDS.map((kind) => [kind, { total: 0, covered: 0, unsupported: 0 }]),
    ) as RtdbFileCoverage['byKind'];
    let covered = 0;
    let unsupportedNodes = 0;
    for (const rule of rules) {
      byKind[rule.kind].total++;
      if (rule.evaluated > 0) {
        byKind[rule.kind].covered++;
        covered++;
      } else if (rule.status === 'unsupported') {
        byKind[rule.kind].unsupported++;
        unsupportedNodes++;
      }
    }
    return {
      rules,
      uncovered: rules.filter((r) => r.status === 'never-evaluated').map((r) => `${r.path} .${r.kind}`),
      missingIndexes: [...this.missing.values()],
      files: [
        {
          file: options.file ?? null,
          total: rules.length,
          covered,
          neverEvaluated: rules.filter((r) => r.status === 'never-evaluated').length,
          unsupported: unsupportedNodes,
          byKind,
        },
      ],
    };
  }
}

/** One line per rule node, then the per-file totals and the nodes never evaluated. */
export function renderRtdbCoverage(summary: RtdbCoverageSummary): string {
  const lines: string[] = [];
  for (const file of summary.files) {
    lines.push(`Rule coverage: ${file.file ?? 'rules'}`);
    lines.push(
      `  ${file.covered} of ${file.total} rules evaluated, ${file.neverEvaluated} never evaluated, ${file.unsupported} unsupported`,
    );
    for (const kind of KINDS) {
      const { total, covered, unsupported } = file.byKind[kind];
      if (total > 0) lines.push(`  .${kind}: ${covered} of ${total}${unsupported > 0 ? `, ${unsupported} unsupported` : ''}`);
    }
  }
  lines.push('');
  for (const rule of summary.rules) {
    const where = rule.line !== undefined ? ` (line ${rule.line})` : '';
    const counts = rule.status === 'never-evaluated'
      ? 'never evaluated'
      : `${rule.status} (allow ${rule.allow}, deny ${rule.deny}, error ${rule.error}${rule.unsupported > 0 ? `, unsupported ${rule.unsupported}` : ''})`;
    lines.push(`${rule.path} .${rule.kind}${where}: ${counts}`);
  }
  if (summary.missingIndexes.length > 0) {
    lines.push('', 'Queries without a declared index:');
    for (const miss of summary.missingIndexes) lines.push(`  ${miss.path} needs .indexOn "${miss.index}"`);
  }
  return lines.join('\n');
}
