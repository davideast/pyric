/**
 * Per-service rule detail views (Firestore, RTDB, Storage) and source-map line
 * resolution for Pyric Studio's `RulesDebug` inspector.
 */
import { useState, type ReactNode } from 'react';

import { LazyRulesCodeEditor } from './LazyRulesCodeEditor.js';
import {
  firestoreRulesetLabel,
  projectRtdbTrace,
  queryProofFailure,
  rtdbRuleLine,
  type Denial,
  type RtdbTraceRow,
  type RuleExplanation,
  type TraceStep,
} from './model.js';

export function RulesField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-slate-gray">
        {label}
      </span>
      {children}
    </div>
  );
}

const PYRIC_SOURCE_MAP_MARKER = '// @pyric-source-map:';
const CITATION_LOCATION_RE = /^(.+):(\d+):(\d+)$/;

export interface AuthoredRuleLocation {
  line?: number;
  col?: number;
  column?: number;
  file?: string;
  citation?: string;
  expression?: string;
}

interface PyricSourceMapEntry {
  generatedLine: number;
  authoredLine: number;
  authoredCol: number;
  authoredFile: string;
  expression?: string;
}

interface NormalizedAuthoredLocation {
  line: number;
  col?: number;
  file?: string;
  expression?: string;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isPyricSourceMapEntry(value: unknown): value is PyricSourceMapEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!isPositiveInteger(record.generatedLine)) return false;
  if (!isPositiveInteger(record.authoredLine)) return false;
  if (typeof record.authoredCol !== 'number' || !Number.isFinite(record.authoredCol)) return false;
  if (typeof record.authoredFile !== 'string' || record.authoredFile.length === 0) return false;
  if (record.expression !== undefined && typeof record.expression !== 'string') return false;
  return true;
}

function hasPyricSourceMapMarker(sourceText: string): boolean {
  return sourceText.includes(PYRIC_SOURCE_MAP_MARKER);
}

function parsePyricSourceMapEntries(sourceText: string): PyricSourceMapEntry[] | null {
  const markerIndex = sourceText.indexOf(PYRIC_SOURCE_MAP_MARKER);
  if (markerIndex === -1) return null;
  const startIndex = markerIndex + PYRIC_SOURCE_MAP_MARKER.length;
  const endIndex = sourceText.indexOf('\n', startIndex);
  let rawJson = sourceText.slice(startIndex).trim();
  if (endIndex !== -1) {
    rawJson = sourceText.slice(startIndex, endIndex).trim();
  }
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isPyricSourceMapEntry);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function stripPyricSourceMap(source: string): string {
  const markerIndex = source.indexOf(PYRIC_SOURCE_MAP_MARKER);
  if (markerIndex === -1) return source;
  return source.slice(0, markerIndex).trimEnd();
}

function cleanFirestoreRulesSource(rawSource: string | undefined): string | undefined {
  if (rawSource === undefined) return undefined;
  const stripped = stripPyricSourceMap(rawSource);
  if (stripped.trim().length === 0) return undefined;
  return stripped;
}

function parseCitationLocation(citation: string | undefined): {
  file: string;
  line: number;
  col: number;
} | null {
  if (citation === undefined) return null;
  const trimmed = citation.trim();
  if (trimmed.length === 0) return null;
  const match = CITATION_LOCATION_RE.exec(trimmed);
  if (match === null) return null;
  const file = match[1];
  const line = Number(match[2]);
  const col = Number(match[3]);
  if (file === undefined || file.length === 0) return null;
  if (!isPositiveInteger(line) || !isPositiveInteger(col)) return null;
  return { file, line, col };
}

function normalizeAuthoredLocation(
  target: number | AuthoredRuleLocation | undefined,
): NormalizedAuthoredLocation | undefined {
  if (target === undefined) return undefined;
  if (typeof target === 'number') {
    if (!isPositiveInteger(target)) return undefined;
    return { line: target };
  }
  const fromCitation = parseCitationLocation(target.citation);
  let line: number | undefined;
  if (isPositiveInteger(target.line)) {
    line = target.line;
  } else if (fromCitation !== null) {
    line = fromCitation.line;
  }
  if (line === undefined) return undefined;

  let col: number | undefined;
  if (isPositiveInteger(target.col)) {
    col = target.col;
  } else if (isPositiveInteger(target.column)) {
    col = target.column;
  } else if (fromCitation !== null) {
    col = fromCitation.col;
  }

  let file: string | undefined;
  if (typeof target.file === 'string' && target.file.trim().length > 0) {
    file = target.file.trim();
  } else if (fromCitation !== null) {
    file = fromCitation.file;
  }

  let expression: string | undefined;
  if (typeof target.expression === 'string' && target.expression.trim().length > 0) {
    expression = target.expression;
  }

  const normalized: NormalizedAuthoredLocation = { line };
  if (col !== undefined) normalized.col = col;
  if (file !== undefined) normalized.file = file;
  if (expression !== undefined) normalized.expression = expression;
  return normalized;
}

function canonicalRuleFileKey(file: string): string {
  let normalized = file.trim();
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (normalized.endsWith('.rules')) {
    normalized = normalized.slice(0, -'.rules'.length);
  }
  return normalized;
}

export function resolveMarkedLine(
  rawSource: string | undefined,
  target: number | AuthoredRuleLocation | undefined,
): number | undefined {
  const normalized = normalizeAuthoredLocation(target);
  if (normalized === undefined) return undefined;
  if (rawSource === undefined) return normalized.line;
  if (!hasPyricSourceMapMarker(rawSource)) {
    return normalized.line;
  }
  const sourceMapEntries = parsePyricSourceMapEntries(rawSource);
  if (sourceMapEntries === null) {
    return undefined;
  }
  let candidates = sourceMapEntries.filter((entry) => entry.authoredLine === normalized.line);
  if (candidates.length === 0) {
    return undefined;
  }
  if (normalized.file !== undefined) {
    const exactFileMatches = candidates.filter((entry) => entry.authoredFile === normalized.file);
    if (exactFileMatches.length > 0) {
      candidates = exactFileMatches;
    } else {
      const targetKey = canonicalRuleFileKey(normalized.file);
      const canonicalMatches = candidates.filter(
        (entry) => canonicalRuleFileKey(entry.authoredFile) === targetKey,
      );
      if (canonicalMatches.length === 0) {
        return undefined;
      }
      candidates = canonicalMatches;
    }
  }
  if (normalized.col !== undefined) {
    const colMatches = candidates.filter((entry) => entry.authoredCol === normalized.col);
    if (colMatches.length === 0) {
      return undefined;
    }
    candidates = colMatches;
  }
  if (candidates.length > 1 && normalized.expression !== undefined) {
    const exprMatches = candidates.filter((entry) => entry.expression === normalized.expression);
    if (exprMatches.length > 0) {
      candidates = exprMatches;
    }
  }
  const generatedLines = new Set(candidates.map((entry) => entry.generatedLine));
  if (generatedLines.size !== 1) {
    return undefined;
  }
  return candidates[0]?.generatedLine;
}

export function ServiceRuleDetail({
  denial,
  exp,
  rulesSource,
  renderTraceStep,
}: {
  denial: Denial;
  exp: RuleExplanation;
  rulesSource?: string;
  renderTraceStep: (step: TraceStep) => ReactNode;
}) {
  if (exp.engine === 'rtdb') {
    return (
      <RtdbRuleDetail
        key={denial.id}
        denial={denial}
        exp={exp}
        rulesSource={rulesSource}
        renderTraceStep={renderTraceStep}
      />
    );
  }
  if (exp.engine === 'storage') {
    return <StorageRuleDetail exp={exp} />;
  }
  return <FirestoreRuleDetail denial={denial} exp={exp} rulesSource={rulesSource} />;
}

function FirestoreRuleDetail({
  denial,
  exp,
  rulesSource,
}: {
  denial: Denial;
  exp: RuleExplanation;
  rulesSource?: string;
}) {
  const failure = queryProofFailure(denial);
  let targetRule: AuthoredRuleLocation | undefined = denial.evaluatedRule;
  if (failure?.rule !== undefined) {
    targetRule = failure.rule;
  }
  const rawLine = targetRule?.line;
  const line = resolveMarkedLine(rulesSource, targetRule);
  const cleanRulesSource = cleanFirestoreRulesSource(rulesSource);
  const allowed = denial.result === 'allow';
  const rulesetName = firestoreRulesetLabel(denial.database);
  const dbSuffix = denial.database !== undefined ? ` (${rulesetName})` : '';

  let fieldLabel: string;
  if (failure) {
    fieldLabel = `query proof - ${exp.ruleNode}${dbSuffix}`;
  } else if (exp.implicitDeny || !exp.ruleNode) {
    fieldLabel = `matched rule${dbSuffix}`;
  } else {
    const linePart = rawLine ? ` - line ${rawLine}` : '';
    fieldLabel = `matched rule - ${exp.ruleNode}${linePart}${dbSuffix}`;
  }

  let ariaLabel: string;
  if (failure) {
    ariaLabel = `Deployed ${rulesetName} - the rule Pyric could not prove is marked`;
  } else if (allowed) {
    ariaLabel = `Deployed ${rulesetName} - the allowing rule is marked`;
  } else {
    ariaLabel = `Deployed ${rulesetName} - the denying rule is marked`;
  }

  const traceLines: string[] = [];
  if (failure?.rule?.expression) {
    traceLines.push(failure.rule.expression);
  }
  traceLines.push(...exp.ruleLines, ...exp.otherLines);

  return (
    <RulesField label={fieldLabel}>
      {failure?.predicate ? (
        <div className="mb-3 text-sm text-slate-gray">
          <p>
            Unsupported predicate
            {failure.predicate.citation ? ` - ${failure.predicate.citation}` : ''}
          </p>
          <pre className="overflow-auto font-mono text-xs">{failure.predicate.expression}</pre>
        </div>
      ) : null}
      {cleanRulesSource !== undefined ? (
        <div data-pyric-ui="firestore-rule-source" data-marked-line={line}>
          <LazyRulesCodeEditor
            value={cleanRulesSource}
            readOnly
            markLine={line}
            markKind={allowed ? 'allow' : 'deny'}
            minHeightRem={12}
            ariaLabel={ariaLabel}
          />
        </div>
      ) : (
        <pre className="overflow-auto rounded-md border border-border bg-content-bg p-3 font-mono text-xs leading-relaxed text-slate-gray">
          {traceLines.join('\n') || '(no trace)'}
        </pre>
      )}
    </RulesField>
  );
}

const TRACE_ROWS_SHOWN = 20;

function RtdbRuleDetail({
  denial,
  exp,
  rulesSource,
  renderTraceStep,
}: {
  denial: Denial;
  exp: RuleExplanation;
  rulesSource?: string;
  renderTraceStep: (step: TraceStep) => ReactNode;
}) {
  const decidingLine = rtdbRuleLine(denial, rulesSource);
  const rows = projectRtdbTrace(denial, rulesSource);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [showAllRows, setShowAllRows] = useState(false);
  const visibleRows = showAllRows ? rows : rows.slice(0, TRACE_ROWS_SHOWN);
  const selected = selectedRow === null ? undefined : rows[selectedRow];
  let line = decidingLine;
  if (selected) {
    line = selected.verdict === 'UNSUPPORTED' ? undefined : selected.line;
  }
  const isAllowed = selected ? selected.verdict === 'ALLOW' : denial.result === 'allow';
  const hasSource = rulesSource !== undefined && rulesSource.trim().length > 0;
  let ruleNodeLabel: string;
  if (exp.implicitDeny || !exp.ruleNode) {
    ruleNodeLabel = 'rule node';
  } else if (decidingLine !== undefined) {
    ruleNodeLabel = `rule node: ${exp.ruleNode} - line ${decidingLine}`;
  } else {
    ruleNodeLabel = `rule node: ${exp.ruleNode}`;
  }

  let ariaLabelText = 'Deployed database.rules.json, the denying rule is marked';
  if (isAllowed) {
    ariaLabelText = 'Deployed database.rules.json, the allowing rule is marked';
  }

  return (
    <>
      <RulesField label={ruleNodeLabel}>
        {hasSource ? (
          <div data-pyric-ui="rtdb-rule-source" data-marked-line={line}>
            <LazyRulesCodeEditor
              value={rulesSource}
              readOnly
              markLine={line}
              markKind={isAllowed ? 'allow' : 'deny'}
              minHeightRem={12}
              ariaLabel={ariaLabelText}
            />
          </div>
        ) : (
          <code className="font-mono text-xs text-soft-white">
            {exp.phase ? `.${exp.phase}` : '(no matching rule)'}
            {denial.rules?.matchedPath ? ` at ${denial.rules.matchedPath}` : ''}
          </code>
        )}
      </RulesField>
      {rows.length > 0 ? (
        <RulesField label="evaluated rules, root first">
          <ul data-pyric-ui="rtdb-trace" className="flex flex-col gap-1">
            {visibleRows.map((row, i) => (
              <RtdbTraceRowItem
                key={i}
                row={row}
                current={i === selectedRow}
                onSelect={() => setSelectedRow(i)}
                renderTraceStep={renderTraceStep}
              />
            ))}
          </ul>
          {rows.length > visibleRows.length ? (
            <button
              type="button"
              data-pyric-ui="rtdb-trace-show-all"
              onClick={() => setShowAllRows(true)}
              className="w-fit font-mono text-xs text-slate-gray hover:text-soft-white"
            >
              show all {rows.length} rules
            </button>
          ) : null}
        </RulesField>
      ) : null}
      {!hasSource && exp.ruleExpression ? (
        <RulesField label="rule expression">
          <pre className="overflow-auto rounded-md border border-border bg-content-bg p-3 font-mono text-xs text-slate-gray">
            {exp.ruleExpression}
          </pre>
        </RulesField>
      ) : null}
      {exp.bindings ? (
        <RulesField label="$variable bindings">
          <code className="font-mono text-xs text-soft-white">
            {Object.entries(exp.bindings)
              .map(([k, v]) => `${k.startsWith('$') ? k : `$${k}`} -> ${v}`)
              .join(', ')}
          </code>
        </RulesField>
      ) : null}
      {denial.rules?.reason ? (
        <RulesField label="simulator reason">
          <code className="font-mono text-xs text-slate-gray">{denial.rules.reason}</code>
        </RulesField>
      ) : null}
    </>
  );
}

function RtdbTraceRowItem({
  row,
  current,
  onSelect,
  renderTraceStep,
}: {
  row: RtdbTraceRow;
  current: boolean;
  onSelect: () => void;
  renderTraceStep: (step: TraceStep) => ReactNode;
}) {
  const bindings = Object.entries(row.bindings);
  return (
    <li
      data-pyric-ui="rtdb-trace-row"
      data-line={row.line}
      aria-current={current ? 'true' : undefined}
      onClick={onSelect}
      className={`flex cursor-pointer flex-col gap-1 rounded-md border px-3 py-2 ${
        current ? 'border-primary bg-primary/10' : 'border-border bg-content-bg hover:bg-sidebar-bg'
      }`}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        className="flex w-fit items-baseline gap-2 font-mono text-xs text-slate-gray"
      >
        <span className="text-soft-white">{row.path}</span>
        <span>.{row.kind}</span>
        {row.line !== undefined ? <span>line {row.line}</span> : null}
      </button>
      {renderTraceStep(row.step)}
      {bindings.length > 0 ? (
        <code className="font-mono text-xs text-slate-gray">
          {bindings.map(([name, value]) => `${name} -> ${value}`).join(', ')}
        </code>
      ) : null}
    </li>
  );
}

function StorageRuleDetail({ exp }: { exp: RuleExplanation }) {
  return (
    <RulesField label={exp.implicitDeny ? 'matched rule' : 'matched rule (match block)'}>
      {exp.ruleNode ? (
        <code className="mb-2 block font-mono text-xs text-soft-white">{exp.ruleNode}</code>
      ) : null}
      <pre className="overflow-auto rounded-md border border-border bg-content-bg p-3 font-mono text-xs leading-relaxed text-slate-gray">
        {[...exp.ruleLines, ...exp.otherLines].join('\n') || '(no trace)'}
      </pre>
    </RulesField>
  );
}
