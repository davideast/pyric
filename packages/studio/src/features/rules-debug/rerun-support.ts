import type { Denial, RuleEngine } from './model.js';

export type RerunSupport =
  | { kind: 'live'; tool: string }
  | { kind: 'pending'; tool: string; hint: string }
  | { kind: 'absent'; missingTool: string; hint: string };

export interface ServiceRerunSupport {
  impersonate: RerunSupport;
  editedRuleset: RerunSupport;
}

function engineOf(denial: Denial): RuleEngine {
  const engine = denial.rules?.engine ?? denial.service;
  return engine === 'rtdb' || engine === 'storage' ? engine : 'firestore';
}

/** Mechanical re-run capability available to Studio for each rules engine. */
export function rerunSupport(denial: Denial): ServiceRerunSupport {
  switch (engineOf(denial)) {
    case 'firestore':
      return {
        impersonate: {
          kind: 'live',
          tool: "worker setLens({mode:'as',uid}) → Firestore replay",
        },
        editedRuleset: {
          kind: 'live',
          tool: 'fork + firestore_lint_rules + firestore_simulate_rules',
        },
      };
    case 'rtdb':
      return {
        impersonate: {
          kind: 'pending',
          tool: 'rtdb_simulate_access',
          hint: 'RTDB re-runs through the local rules simulator as this user once the Studio worker exposes rtdb_simulate_access. This is a simulation, not a live re-issue — RTDB has no live local enforcement path.',
        },
        editedRuleset: {
          kind: 'pending',
          tool: 'RulesEvaluator.setRules + rtdb_simulate_access',
          hint: 'Editing the RTDB ruleset re-simulates the write once the worker exposes the RTDB simulator. Note: there is no whole-ruleset RTDB linter yet (rtdb_build_expression lints a single expression).',
        },
      };
    case 'storage':
      return {
        impersonate: {
          kind: 'absent',
          missingTool: 'storage_simulate_rules',
          hint: 'Storage rules are enforced and evaluated allow/deny events open this inspector, but Studio has no Storage replay operation to re-run this request as a user.',
        },
        editedRuleset: {
          kind: 'absent',
          missingTool: 'storage_simulate_rules + edited-rules deployment seam',
          hint: 'Storage rules are enforced and denial events are inspectable. Testing an edit still needs a Studio Storage replay operation plus a temporary edited-rules deployment seam.',
        },
      };
  }
}
