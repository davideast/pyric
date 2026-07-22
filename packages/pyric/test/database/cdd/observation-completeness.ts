import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

interface ObservationLink {
  name: string;
  rowIds: string[];
}

interface EvidenceRow {
  id: string;
  surface: string;
  oracleObservations: string[];
}

export interface ObservationCompletenessInput {
  observations: ObservationLink[];
  rows: EvidenceRow[];
  assertedRowIds: string[];
  notApplicable: Readonly<Record<string, string>>;
}

export interface ObservationCompletenessResult {
  uncovered: string[];
  duplicateAssertions: string[];
  invalidNotApplicable: string[];
  staleCitations: string[];
  unassertedRows: string[];
  unknownAssertions: string[];
}

const OBSERVATION_PREFIX = 'rtdb-modular-';
const ROW_PREFIX = 'rtdb-modular#';

/**
 * Audits the evidence graph used by the RTDB CDD suite:
 *
 * committed observation -> observation rowIds -> registry citation ->
 * row-keyed CDD assertion.
 *
 * `assertedRowIds` comes from parsing the suite's literal `row(...)`
 * registrations. This audit requires every registry row exactly once, then
 * checks the opposite direction: a newly committed observation cannot
 * disappear between those executable rows.
 */
export function auditObservationCompleteness({
  observations,
  rows,
  assertedRowIds,
  notApplicable,
}: ObservationCompletenessInput): ObservationCompletenessResult {
  const observationNames = new Set(observations.map(({ name }) => name));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const assertionCounts = new Map<string, number>();
  for (const rowId of assertedRowIds) {
    assertionCounts.set(rowId, (assertionCounts.get(rowId) ?? 0) + 1);
  }

  const duplicateAssertions = [...assertionCounts]
    .filter(([, count]) => count !== 1)
    .map(([rowId, count]) => `${rowId}: ${count} assertion sets`)
    .sort();
  const unassertedRows = rows
    .filter(({ id }) => assertionCounts.get(id) !== 1)
    .map(({ id }) => id)
    .sort();
  const unknownAssertions = [...assertionCounts.keys()]
    .filter((rowId) => !rowsById.has(rowId))
    .sort();

  const invalidNotApplicable = Object.entries(notApplicable)
    .flatMap(([name, reason]) => {
      const errors: string[] = [];
      if (!observationNames.has(name)) errors.push(`${name}: no committed observation`);
      if (reason.trim().length === 0) errors.push(`${name}: reason is empty`);
      return errors;
    })
    .sort();

  const uncovered = observations
    .filter(({ name, rowIds }) => {
      if (name in notApplicable) return false;
      return !rowIds.some((rowId) => {
        if (!rowId.startsWith(ROW_PREFIX)) return false;
        const row = rowsById.get(rowId);
        return row?.surface === 'rtdb-modular'
          && row.oracleObservations.includes(name)
          && assertionCounts.get(rowId) === 1;
      });
    })
    .map(({ name }) => name)
    .sort();

  const staleCitations = rows
    .flatMap((row) => row.oracleObservations
      .filter((name) => name.startsWith(OBSERVATION_PREFIX) && !observationNames.has(name))
      .map((name) => `${row.id}: ${name}`))
    .sort();

  return {
    uncovered,
    duplicateAssertions,
    invalidNotApplicable,
    staleCitations,
    unassertedRows,
    unknownAssertions,
  };
}

/** Discovers the literal row IDs registered by the CDD suite's `row(...)` calls. */
export function discoverCddAssertionRowIds(directory: string): string[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.test.ts'))
    .sort()
    .flatMap((file) => {
      const path = join(directory, file);
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const rowIds: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === 'row') {
          const id = node.arguments[0];
          if (!id || !ts.isStringLiteralLike(id)) {
            throw new Error(`${path}: CDD row() must use a literal row id`);
          }
          rowIds.push(`${ROW_PREFIX}${id.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return rowIds;
    });
}
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
