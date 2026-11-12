/**
 * Measured production cost of the Security Rules standard library.
 *
 * Every exported function in `stdlib/*.rules` carries a cost record in its
 * module's `*.test.json`, a matching line in the comment above the function,
 * and the same numbers on its catalog entry in `stdlib-modules.ts`. The
 * numbers are expressions counted toward production's per-request limit of
 * 1000, per call: the call itself, its `let` bindings and its body, not the
 * arguments the caller passes. Calls are not memoized, so every call pays
 * again. `packages/conformance/src/measure-stdlib-cost.ts` measures them
 * against the Rules Test API.
 *
 * This file is browser-safe: it parses text and never reads the filesystem.
 */

/** Production cost of one standard library function. */
export interface StdlibCostRecord {
  /** Exported function name. */
  function: string;
  /** Expressions per call on the cheapest and the most expensive measured path. */
  cost: { min: number; max: number };
  /** get() and exists() calls one call of the function can spend. */
  reads: number;
}

/** A module's test file: the case array and one cost record per export. */
export interface StdlibTestFile<Case = unknown> {
  costs: StdlibCostRecord[];
  cases: Case[];
}

/** Parse a module test file and check the cost records' shape. */
export function parseStdlibTestFile<Case = unknown>(text: string, file = 'test file'): StdlibTestFile<Case> {
  const value = JSON.parse(text) as Partial<StdlibTestFile<Case>>;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.cases) || !Array.isArray(value.costs)) {
    throw new Error(`${file}: expected an object with "costs" and "cases" arrays`);
  }
  for (const record of value.costs) {
    const problem = costRecordProblem(record);
    if (problem) throw new Error(`${file}: ${problem}`);
  }
  return value as StdlibTestFile<Case>;
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

function costRecordProblem(record: unknown): string | null {
  const r = record as Partial<StdlibCostRecord>;
  if (!r || typeof r.function !== 'string' || r.function.length === 0) return 'cost record without a function name';
  if (!r.cost || !isCount(r.cost.min) || !isCount(r.cost.max)) return `${r.function}: cost.min and cost.max must be non-negative integers`;
  if (r.cost.min > r.cost.max) return `${r.function}: cost.min ${r.cost.min} is above cost.max ${r.cost.max}`;
  if (!isCount(r.reads)) return `${r.function}: reads must be a non-negative integer`;
  return null;
}

/** The comment line that states a function's cost. */
export function formatCostLine(record: Pick<StdlibCostRecord, 'cost' | 'reads'>): string {
  const reads = record.reads > 0 ? `, reads ${record.reads}` : '';
  return `// cost ${record.cost.min} to ${record.cost.max} expressions per call${reads}`;
}

const COST_LINE = /^\/\/ cost (\d+) to (\d+) expressions per call(?:, reads (\d+))?$/;

/** The sentence every module header carries about per-call cost. */
export const PER_CALL_NOTE =
  'Costs are production expressions per call, not counting arguments. Calls are not memoized: every call pays its full cost again, and a let inside a function is paid on every call.';

export interface ModuleFunctionComment {
  name: string;
  /** Index of the `export function` line. */
  line: number;
  /** Lines of the comment block directly above the function. */
  comment: string[];
  /** Cost stated in the comment, or null when no cost line is present. */
  stated: Pick<StdlibCostRecord, 'cost' | 'reads'> | null;
}

/** Exported functions of a module with the comment block above each. */
export function moduleFunctionComments(source: string): ModuleFunctionComment[] {
  const lines = source.split('\n');
  const out: ModuleFunctionComment[] = [];
  lines.forEach((text, line) => {
    const m = /^export function (\w+)\s*\(/.exec(text);
    if (!m) return;
    let start = line;
    while (start > 0 && lines[start - 1]!.startsWith('//')) start--;
    const comment = lines.slice(start, line);
    let stated: ModuleFunctionComment['stated'] = null;
    for (const c of comment) {
      const hit = COST_LINE.exec(c.trim());
      if (hit) stated = { cost: { min: Number(hit[1]), max: Number(hit[2]) }, reads: hit[3] ? Number(hit[3]) : 0 };
    }
    out.push({ name: m[1]!, line, comment, stated });
  });
  return out;
}

/** The module's leading comment block as one line of prose. */
export function moduleHeaderText(source: string): string {
  const lines = source.split('\n');
  const header: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('//')) break;
    header.push(line.replace(/^\/\/\s?/, ''));
  }
  return header.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Disagreements between a module's text and its cost records: a missing or
 * extra record, a record out of export order, a function comment without a
 * cost line or with a different one, and a header without the per-call note.
 */
export function costDrift(moduleName: string, source: string, records: readonly StdlibCostRecord[]): string[] {
  const problems: string[] = [];
  const functions = moduleFunctionComments(source);
  const names = functions.map((f) => f.name);
  const recorded = records.map((r) => r.function);
  if (JSON.stringify(names) !== JSON.stringify(recorded)) {
    problems.push(`${moduleName}: cost records [${recorded.join(', ')}] do not list the exports [${names.join(', ')}] in order`);
  }
  if (!moduleHeaderText(source).includes(PER_CALL_NOTE)) {
    problems.push(`${moduleName}: module header lacks the per-call note: "${PER_CALL_NOTE}"`);
  }
  for (const fn of functions) {
    const record = records.find((r) => r.function === fn.name);
    if (!record) continue;
    const expected = formatCostLine(record);
    if (!fn.stated) {
      problems.push(`${moduleName}.${fn.name}: comment lacks "${expected}"`);
    } else if (formatCostLine(fn.stated) !== expected) {
      problems.push(`${moduleName}.${fn.name}: comment says "${formatCostLine(fn.stated)}" but the record says "${expected}"`);
    }
  }
  return problems;
}

/**
 * Rewrite a module so each exported function's comment ends with its cost
 * line and the header carries the per-call note. Used by the measurement
 * script after a run; the drift check reads the result.
 */
export function applyCostLines(source: string, records: readonly StdlibCostRecord[]): string {
  let lines = source.split('\n');
  // Drop existing cost lines, then insert fresh ones above each export.
  lines = lines.filter((l) => !COST_LINE.test(l.trim()));
  const out: string[] = [];
  for (const line of lines) {
    const m = /^export function (\w+)\s*\(/.exec(line);
    const record = m ? records.find((r) => r.function === m[1]) : undefined;
    if (record) out.push(formatCostLine(record));
    out.push(line);
  }
  let text = out.join('\n');
  if (!moduleHeaderText(text).includes(PER_CALL_NOTE)) {
    const headerLines = text.split('\n');
    let at = 0;
    while (at < headerLines.length && /^\/\/ @pyric-/.test(headerLines[at]!)) at++;
    headerLines.splice(at, 0, ...wrapComment(PER_CALL_NOTE), '//');
    text = headerLines.join('\n');
  }
  return text;
}

function wrapComment(text: string, width = 76): string[] {
  const out: string[] = [];
  let line = '//';
  for (const word of text.split(' ')) {
    if (line.length + 1 + word.length > width && line !== '//') {
      out.push(line);
      line = '//';
    }
    line += ` ${word}`;
  }
  out.push(line);
  return out;
}
