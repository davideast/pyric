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

function parsePyricSourceMapEntries(sourceText: string): Array<{
  generatedLine: number;
  authoredLine: number;
  authoredCol: number;
  authoredFile: string;
}> | null {
  const marker = '// @pyric-source-map:';
  const markerIndex = sourceText.indexOf(marker);
  if (markerIndex === -1) return null;
  const rawJson = sourceText.slice(markerIndex + marker.length).trim();
  try {
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function stripPyricSourceMap(source: string): string {
  const marker = '// @pyric-source-map:';
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return source;
  return source.slice(0, markerIndex).trimEnd();
}

export function resolveMarkedLine(
  rawSource: string | undefined,
  authoredLine: number | undefined,
): number | undefined {
  if (rawSource === undefined || authoredLine === undefined) return authoredLine;
  const sourceMapEntries = parsePyricSourceMapEntries(rawSource);
  if (sourceMapEntries !== null) {
    const matchingEntry = sourceMapEntries.find((entry) => entry.authoredLine === authoredLine);
    if (matchingEntry !== undefined) {
      return matchingEntry.generatedLine;
    }
  }
  return authoredLine;
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
  const rawLine = failure?.rule?.line ?? denial.evaluatedRule?.line;
  const line = resolveMarkedLine(rulesSource, rawLine);
  let cleanRulesSource: string | undefined;
  if (rulesSource !== undefined) {
    cleanRulesSource = stripPyricSourceMap(rulesSource);
  }
  const allowed = denial.result === 'allow';
  const showSource = Boolean(cleanRulesSource && cleanRulesSource.trim().length > 0);
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
      {showSource ? (
        <LazyRulesCodeEditor
          value={cleanRulesSource!}
          readOnly
          markLine={line}
          markKind={allowed ? 'allow' : 'deny'}
          minHeightRem={12}
          ariaLabel={ariaLabel}
        />
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
