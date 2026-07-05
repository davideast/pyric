import type { ReactNode } from 'react';
import type { Denial, DenialInspectorProps, ExprTraceEntry } from '../types.js';
import {
  denialReason,
  markRuleLines,
  decidingEvaluation,
  formatValue,
  traceDepth,
} from './format.js';
import { scopeVars } from './scope.js';

function lensUid(denial: Denial): string | undefined {
  const lens = denial.lens;
  if (lens && typeof lens === 'object' && 'as' in lens) return lens.as;
  return denial.auth?.uid;
}

/** Render one scope value, underlining the keys the rule read. */
function ScopeValue({ value, hits }: { value: unknown; hits: string[] }): ReactNode {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return <>{formatValue(value)}</>;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const hitSet = new Set(hits);
  return (
    <>
      {'{ '}
      {entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 ? ', ' : ''}
          {k}:{' '}
          {hitSet.has(k) ? (
            <span data-pyric-scope-hit="">{formatValue(v)}</span>
          ) : (
            formatValue(v)
          )}
        </span>
      ))}
      {' }'}
    </>
  );
}

/** The step-through evaluation: each sub-expression and its real value. */
function EvaluationTrace({ trace }: { trace: ExprTraceEntry[] }): ReactNode {
  return (
    <div data-pyric-trace="">
      {trace.map((node, i) => {
        const depth = traceDepth(trace, i);
        const isFalse = node.value === false;
        return (
          <div
            key={i}
            data-pyric-trace-node=""
            data-pyric-depth={depth}
            {...(node.skipped ? { 'data-pyric-skipped': '' } : {})}
            {...(node.letBinding ? { 'data-pyric-let': node.letBinding.name } : {})}
            {...(node.inlinedFrom ? { 'data-pyric-frame': node.inlinedFrom.name } : {})}
          >
            <span data-pyric-trace-source="">{node.source}</span>
            <span data-pyric-trace-value="" {...(isFalse ? { 'data-pyric-false': '' } : {})}>
              {node.skipped
                ? 'skipped'
                : node.error != null
                  ? `error: ${node.error}`
                  : formatValue(node.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Headless inspector for a single denied Firestore request. Renders, per
 * the `denial-inspector-spec`:
 *   - the plain-language reason (`data-pyric-denial-reason`)
 *   - the rule source, line-marked (`data-pyric-rule-source`, per-line
 *     `data-pyric-line-verdict="deny|allow|skip"`)
 *   - the expression step-through (`data-pyric-trace` + per-node hooks)
 *   - data in scope (`data-pyric-scope`, `-scope-var`, `-scope-hit`)
 *   - the re-run / verify loop (`data-pyric-rerun`)
 *   - the cluster of sibling denials (`data-pyric-denial-cluster`)
 *   - path resolution for no-match denials (`data-pyric-path-resolution`)
 *
 * Zero styling — every visual decision is a consumer's via the
 * `data-pyric-*` hooks. `mocks/c-debug.html` is the CSS spec.
 */
export function DenialInspector({
  denial,
  cluster,
  onRerunAs,
  onTestEditedRule,
  onSelectCluster,
  className,
}: DenialInspectorProps) {
  const deciding = decidingEvaluation(denial.evaluation);
  const lines = markRuleLines(denial.rulesSource, denial.evaluation, denial.method);
  const scope = scopeVars(denial);
  const rerunUid = lensUid(denial);
  const isNoMatch = denial.evaluation.length === 0;

  return (
    <div className={className} data-pyric-ui="denial-inspector">
      <header data-pyric-denial-header="">
        <p data-pyric-denial-title="">
          Denied: <span data-pyric-denial-method="">{denial.method}</span>{' '}
          <span data-pyric-denial-path="">{denial.path}</span>
        </p>
        <p data-pyric-denial-context="">
          {denial.auth ? `by ${denial.auth.uid}` : 'unauthenticated'}
          {denial.lens && typeof denial.lens === 'object' && 'as' in denial.lens
            ? ` · acting as ${denial.lens.as}`
            : denial.lens === 'admin'
              ? ' · admin'
              : ''}
        </p>
      </header>

      {/* Reason */}
      <p data-pyric-denial-reason="">
        {denialReason(denial.evaluation, denial.method, denial.path)}
      </p>

      {/* Rule source, line-marked */}
      <section data-pyric-rule-source="">
        {lines.map((line) => (
          <div
            key={line.number}
            data-pyric-rule-line=""
            data-pyric-line-number={line.number}
            {...(line.verdict ? { 'data-pyric-line-verdict': line.verdict } : {})}
          >
            <span data-pyric-line-gutter="">{line.number}</span>
            <span data-pyric-line-text="">{line.text}</span>
            {line.note ? <span data-pyric-line-note="">{line.note}</span> : null}
            {line.verdict === 'deny' ? (
              <span data-pyric-line-badge="">denied</span>
            ) : null}
          </div>
        ))}
      </section>

      {/* Evaluation step-through */}
      {deciding?.expressionTrace && deciding.expressionTrace.length > 0 ? (
        <EvaluationTrace trace={deciding.expressionTrace} />
      ) : null}

      {/* Data in scope */}
      {scope.length > 0 ? (
        <section data-pyric-scope="">
          {scope.map((v) => (
            <div key={v.name} data-pyric-scope-var={v.name}>
              <span data-pyric-scope-name="">{v.name}</span>
              <span data-pyric-scope-tag="">{v.tag}</span>
              <span data-pyric-scope-value="">
                <ScopeValue value={v.value} hits={v.hits} />
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {/* Path resolution — only for no-match (default-deny) denials */}
      {isNoMatch && denial.pathResolution ? (
        <section data-pyric-path-resolution="">
          {denial.pathResolution.attempts.map((attempt, i) => (
            <div
              key={i}
              data-pyric-path-attempt=""
              data-pyric-matched-segments={`${attempt.matchedSegments}/${attempt.totalSegments}`}
              {...(attempt.matched ? { 'data-pyric-matched': '' } : {})}
              {...(attempt.reason ? { 'data-pyric-reason': attempt.reason } : {})}
            >
              <span data-pyric-attempt-path="">{attempt.blockPath}</span>
              {attempt.reason ? (
                <span data-pyric-attempt-reason="">{attempt.reason}</span>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      {/* Re-run / verify */}
      {onRerunAs || onTestEditedRule ? (
        <section data-pyric-rerun="">
          {onRerunAs && rerunUid ? (
            <button
              type="button"
              data-pyric-rerun-as=""
              data-pyric-rerun-uid={rerunUid}
              onClick={() => onRerunAs(rerunUid)}
            >
              Re-run as {rerunUid}
            </button>
          ) : null}
          {onTestEditedRule ? (
            <button
              type="button"
              data-pyric-test-edited-rule=""
              onClick={() => onTestEditedRule()}
            >
              Test against an edited rule
            </button>
          ) : null}
        </section>
      ) : null}

      {/* Cluster of sibling denials */}
      {cluster && cluster.length > 0 ? (
        <section data-pyric-denial-cluster="">
          {cluster.map((sibling, i) => (
            <button
              key={i}
              type="button"
              data-pyric-cluster-item=""
              onClick={() => onSelectCluster?.(sibling)}
            >
              <span data-pyric-cluster-path="">{sibling.path}</span>
            </button>
          ))}
        </section>
      ) : null}
    </div>
  );
}
