/**
 * Live lint feedback for the Rules editor. Debounced so we don't run
 * the parser on every keystroke — 250ms catches the moment the user
 * stops typing and feels instant.
 *
 * Returns the most recent `LintResult` (with `parseError` distinct
 * from `warnings`) plus an `isLinting` flag the UI uses to dim the
 * strip while debouncing.
 */
import { useEffect, useState } from 'react';
import { lintFirestoreRules, type LintResult } from 'pyric/rules/internal';
import { useWorkspaceStore } from '~/lib/store/workspace';

const DEBOUNCE_MS = 250;

export interface UseRulesLintResult {
  result: LintResult | null;
  isLinting: boolean;
}

export function useRulesLint(): UseRulesLintResult {
  const rules = useWorkspaceStore((s) => s.rules);
  const [result, setResult] = useState<LintResult | null>(null);
  const [isLinting, setIsLinting] = useState(false);

  useEffect(() => {
    setIsLinting(true);
    const id = setTimeout(() => {
      try {
        setResult(lintFirestoreRules(rules));
      } catch (e) {
        // Linter can throw on truly malformed inputs that bypass the
        // structured `parseError` path. Surface as a synthetic parse
        // error so the strip still renders something useful.
        setResult({
          warnings: [],
          metrics: {
            sourceSize: rules.length,
            functionCount: 0,
            allowRuleCount: 0,
            maxChainDepth: 0,
            maxChainOp: '',
            maxLetBindings: 0,
            maxLetBindingsFunction: '',
            maxCallDepth: 0,
            maxEstimatedExpressions: 0,
            getCallCount: 0,
          },
          parseError: {
            line: 1,
            column: 1,
            offset: 0,
            expected: 'valid rules source',
            actual: e instanceof Error ? e.message : String(e),
            message: e instanceof Error ? e.message : String(e),
          },
        });
      } finally {
        setIsLinting(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rules]);

  return { result, isLinting };
}
