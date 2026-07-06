/**
 * Diagnostic playbook — ONE compact block replacing the five per-tool
 * skill blocks (simulate-write, seed-admin, generate-fixture,
 * try-rules-edit, debug-rules) that used to ship ~1.5k tokens of
 * walkthrough prose every turn (W2.2 prompt collapse). Each line keeps
 * only the WHEN + the one invariant that prevents damage; the full
 * contracts moved to `man diagnostics` (pull-based, zero standing cost).
 *
 * Static body — doesn't depend on workspace state. Gating happens
 * upstream in `system-prompt.ts` (`diagnosticsEnabled` wraps the whole
 * DIAGNOSTIC_BLOCKS loop).
 */
import type { PromptBlock } from './index';

const BODY = [
  '- Rule denial (user-reported or in traffic)? `debug_firestore_rules` FIRST — it re-simulates with the expression trace, reads doc state, lints, and returns one `diagnosis` (quote its `summary`; your fix must address `failingExpression`).',
  '- After writing rules: `simulate_firestore_write` once per distinct operation/auth shape, before telling the user to deploy. OMIT `rules` — it evaluates the deployed ruleset; re-passing it every call bloats the context.',
  '- Before proposing a rule edit on an exercised session: `try_rules_edit` replays captured history — surface every `regression.nowDenied[]` to the user before applying; `stats.fixes == 0` means the edit doesn\'t actually fix the denial.',
  '- `seed_firestore_data_as_admin` is FIXTURE setup only (admin bypass, rules NOT consulted; set/delete, ≤100 ops). Testing whether rules ALLOW a write is `simulate_firestore_write`\'s job.',
  '- After the user validates a flow end-to-end: `generate_fixture_from_session` captures it as a permanent replay fixture (surface `data.serialized` — it does NOT write to disk).',
  'Full contracts, result shapes, and edge cases: `man diagnostics` (bash tool).',
].join('\n');

export const playbookBlock: PromptBlock = {
  heading: 'DIAGNOSTIC PLAYBOOK',
  render: () => BODY,
};
