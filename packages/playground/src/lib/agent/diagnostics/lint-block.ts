/**
 * Inline rules-lint block. Reads the current rules source from the
 * workspace store and emits `lintFirestoreRules` output so the agent
 * sees parse errors + warnings inline every turn — without having to
 * call a tool. Pyric-specific: this is the playground's value-add on
 * top of the bare write/run loop.
 */
import { lintFirestoreRules, type LintWarning } from 'pyric/rules/internal';
import { useWorkspaceStore } from '~/lib/store/workspace';
import type { PromptBlock } from './index';

function adaptSeverity(w: LintWarning): 'ERROR' | 'WARN' | 'INFO' {
  if (w.severity === 'error') return 'ERROR';
  return 'WARN';
}

export const lintBlock: PromptBlock = {
  heading: 'RULES LINT',
  render() {
    const rules = useWorkspaceStore.getState().rules;
    // No rules authored yet — nothing meaningful to lint. Skip the
    // block entirely so the prompt stays compact.
    if (rules.trim().length === 0) return null;
    const lint = lintFirestoreRules(rules);
    const lines: string[] = [];
    if (lint.parseError) {
      lines.push(
        `PARSE ERROR at ${lint.parseError.line}:${lint.parseError.column} — expected ${lint.parseError.expected}${lint.parseError.actual ? `, got ${JSON.stringify(lint.parseError.actual.slice(0, 40))}` : ''}`,
      );
    }
    for (const w of lint.warnings) {
      const loc = w.location;
      const where = loc?.functionName
        ? `in ${loc.functionName}: `
        : loc?.matchPath
          ? `at ${loc.matchPath}: `
          : '';
      lines.push(`${adaptSeverity(w)}: ${where}${w.rule ? `[${w.rule}] ` : ''}${w.message}`);
    }
    return lines.length === 0 ? 'rules ok — no parse errors, no warnings' : lines.join('\n');
  },
};
