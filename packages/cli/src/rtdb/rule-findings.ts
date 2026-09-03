/**
 * Findings collected from a compiled Realtime Database ruleset: every
 * expression parse error or lint warning, keyed by the path and rule it was
 * found on. Shared by the CLI's lint and validate commands and the
 * `database_rules` tool handlers so both report the same shape.
 */
import type { RtdbNode } from 'pyric/rules/internal/rtdb';

export interface RtdbRuleFinding {
  path: string;
  rule: '.read' | '.write' | '.validate';
  code: string;
  message: string;
}

export function collectRtdbRuleFindings(
  node: RtdbNode,
  kind: 'errors' | 'warnings',
): RtdbRuleFinding[] {
  const findings: RtdbRuleFinding[] = [];
  const rules = [
    ['.read', node.read],
    ['.write', node.write],
    ['.validate', node.validate],
  ] as const;
  for (const [rule, expr] of rules) {
    for (const finding of expr?.parsed[kind] ?? []) {
      findings.push({
        path: node.path,
        rule,
        code: finding.code,
        message: finding.message,
      });
    }
  }
  for (const child of node.children) {
    findings.push(...collectRtdbRuleFindings(child, kind));
  }
  return findings;
}
