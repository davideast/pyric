/**
 * Claude lane system prompt — the DELEGATED twin of `./system-prompt.ts`.
 *
 * Why this exists (user-found, 2026-06-11, trace t-mq9msa9m-xcgt): the
 * playground used to send its canonical react-loop prompt through the
 * Claude (local CLI) lane. That prompt mandates tools by their
 * playground names ("Call `firestore_rules_stdlib_list` ONCE early"),
 * but the `claude -p` session only sees the MCP bridge's
 * `mcp__playground__*` surface — so a real Opus turn obeyed the mandate
 * by emitting the call AS TEXT, made zero tool calls, and burned $0.05
 * producing nothing. The prompt must describe the tool surface the
 * session ACTUALLY has.
 *
 * Composition contract (ONE source of truth — no forked prose):
 *
 *   KEPT VERBATIM (imported from `./system-prompt.ts` / the diagnostic
 *   blocks — the #575/W2.2-pinned content):
 *     - INTRO_IDENTITY        (what the agent is + the workspace)
 *     - SCOPE                 (canonical imports, auth-UI rules, deny-lists)
 *     - AUTH_SHAPE            (sandbox.withAuth contract)
 *     - TOOL_TRUTHFULNESS     (empty results are the answer)
 *     - UI_STYLE              (mobile-first pure-CSS)
 *     - WORKSPACE FILES references (no file bodies)
 *     - RULES LINT + RULES PITFALLS diagnostic blocks (diagnostics on)
 *
 *   REPLACED (they describe tools this session does not have):
 *     - TOOLS routing paragraph  → MCP_TOOLS below (`mcp__playground__*`)
 *     - DOCS ON DEMAND           → folded into MCP_TOOLS (`man` rides
 *                                  `mcp__playground__bash`)
 *     - RULES STDLIB mandate     → restated against the real MCP names
 *     - DIAGNOSTIC PLAYBOOK / denials / traffic
 *       blocks → dropped: their calls-to-action name tools that are not
 *       mounted on the bridge (debug_firestore_rules, inspect_*,
 *       try_rules_edit, …) — exactly the text-as-tool-call failure mode
 *       this file fixes.
 */
import {
  AUTH_SHAPE,
  FIREBASE_TOOLING_FILE_REFERENCES,
  INTRO_IDENTITY,
  SCOPE,
  TOOL_TRUTHFULNESS,
  UI_STYLE,
  WORKSPACE_FILE_REFERENCES,
  fenced,
  skillBriefSections,
} from './system-prompt';
import { lintBlock } from './diagnostics/lint-block';
import { pitfallsBlock } from './diagnostics/pitfalls-block';
import { resolveActiveSkills, resolvePromptProfile } from '~/lib/skills/registry';
import { useSkillsStore } from '~/lib/store/skills';

interface BuildClaudeLanePromptOpts {
  diagnosticsEnabled: boolean;
}

/** The replacement tool-surface section. Names MUST match what the MCP
 *  bridge serves (`~/lib/server/claude-mcp.ts` `MCP_TOOL_NAMES`, prefixed
 *  `mcp__playground__`) — `claude-lane-prompt.test.ts` pins the pairing. */
const MCP_TOOLS = [
  'TOOLS — you are running as Claude Code with the playground workspace mounted over MCP (server name `playground`). The ONLY callable tools are the `mcp__playground__*` set below; each tool\'s args + behavior are in its schema:',
  '  - `mcp__playground__list_files` / `mcp__playground__search_file` / `mcp__playground__read_file` / `mcp__playground__edit_file` / `mcp__playground__write_file` / `mcp__playground__delete_file` — operate on /workspace/. Prefer search/ranged reads and targeted edits; `write_file` replaces the whole file, so use it for new files or full replacement. Writing `/workspace/firestore.rules` auto-deploys to the sandbox; writing `/workspace/src/App.tsx` recompiles the preview.',
  '  - `mcp__playground__run_workspace_tests` — one call runs the whole /workspace/tests suite against the current rules.',
  '  - `mcp__playground__simulate_firestore_write` — allow/deny simulation of a single operation against the deployed sandbox rules.',
  '  - `mcp__playground__firestore_rules_stdlib_list` / `mcp__playground__firestore_rules_stdlib_get` — the Rules stdlib reference. Call `mcp__playground__firestore_rules_stdlib_list` ONCE before writing any rules, then `_get({ key })` for each module you use. Invoking a rules function NOT in that listing is a hallucination and will fail rules compile.',
  '    AUTHOR RULES WITH IMPORTS, never copy stdlib bodies — write firestore.rules in this shape (`mcp__playground__write_file` inlines imports on save; a bad import returns ok:false with the fix):',
  "      rules_version = '2+modules';",
  "      import { isSpaceMember, hasSpaceRole } from 'spaces';",
  "      import { validString, isOneOf } from 'validation';",
  '      service cloud.firestore { match /databases/{database}/documents {',
  '        match /teams/{id} { allow read: if isSpaceMember(resource.data); } } }',
  '  - `mcp__playground__firestore_lint_rules` — lint a candidate ruleset BEFORE writing it; fixing a finding here is cheaper than a deploy round-trip.',
  '  - `mcp__playground__bash` — jailed shell over /workspace (no network, no subprocesses, no host paths). Ships the playground builtins: `test [pattern]` runs the workspace suite, `lint-rules [path]` lints a rules file, and `man <topic>` prints docs on demand (`man -k` lists topics; read `man rules` BEFORE writing rules, `man test` for the test-file format, `man workflow` for orchestration).',
  '  Claude Code built-ins (Read/Edit/Write/Bash/Grep/…) are NOT available in this session, and playground tools beyond the list above (sandbox discovery, auth seeding, denial diagnostics, checkpoints) are NOT mounted — never reference or "call" a tool that is not in the list.',
  '',
  'WORKFLOW — you own the whole turn; there is no outer agent dispatching for you. A typical build/modify request: read the current files → consult the stdlib (and lint candidates) → write rules + App TSX + tests via `mcp__playground__write_file` → run `mcp__playground__run_workspace_tests` → iterate until green → reply with a concise summary of what changed and why. Your file writes land in the user\'s workspace when the turn ends.',
].join('\n');

const MCP_FIREBASE_TOOLING_PROFILE = [
  'FIREBASE TOOLING MODE — this is not an app build.',
  '  Do NOT create or edit `/workspace/src/App.tsx` unless the user explicitly asks for an app, UI, or preview. Primary outputs are rules, tests, audit reports, schema notes, simulations, and evidence-backed recommendations.',
  '  In this delegated lane, only the listed `mcp__playground__*` tools are callable. Use file tools, rules lint, Firestore simulations, workspace tests, and the rules stdlib for evidence.',
  '  Browser-only evidence such as Auth users, Traffic rows, sandbox discovery, and RTDB runtime inspection is not available through this MCP bridge. If a tooling task needs that evidence, say so explicitly and proceed with the available workspace/rules evidence.',
].join('\n');

const MCP_FIREBASE_TOOLING_WORKFLOW = [
  'WORKFLOW — evidence-first Firebase tooling. Plan briefly, inspect only the relevant files/evidence, analyze risks or data-model tradeoffs, then propose or apply rules/tests/seed artifacts only when requested.',
  'Do not end by building App.tsx. Verify with lint, simulation, or workspace tests when useful.',
].join('\n');

/**
 * Build the Claude lane's system prompt. Mirrors
 * `buildSystemPrompt`'s section order so the protected guidance reads
 * identically; only the tool-surface sections differ.
 */
export function buildClaudeLanePrompt({ diagnosticsEnabled }: BuildClaudeLanePromptOpts): string {
  const promptProfile = resolvePromptProfile(
    resolveActiveSkills(useSkillsStore.getState().activeSkillIds),
  );
  const profileSections =
    promptProfile === 'firebase-tooling'
      ? [
          MCP_FIREBASE_TOOLING_PROFILE,
          '',
          MCP_FIREBASE_TOOLING_WORKFLOW,
          '',
          AUTH_SHAPE,
          '',
          TOOL_TRUTHFULNESS,
          '',
          FIREBASE_TOOLING_FILE_REFERENCES,
        ]
      : [
          SCOPE,
          '',
          AUTH_SHAPE,
          '',
          TOOL_TRUTHFULNESS,
          '',
          UI_STYLE,
          '',
          WORKSPACE_FILE_REFERENCES,
        ];
  const sections: string[] = [
    INTRO_IDENTITY,
    '',
    MCP_TOOLS,
    '',
    ...profileSections,
    // Active-skill briefs — same shared mechanism as buildSystemPrompt
    // (empty when no skills are active). NOTE: skill man pages are a
    // playground-shell surface; the MCP bash mounts the same builtins,
    // so `man <skill>` works in this lane too.
    ...skillBriefSections(),
  ];

  if (diagnosticsEnabled) {
    // Only the self-contained blocks: lint findings (pure state) and the
    // pitfalls primer (pinned guidance). The other diagnostic blocks
    // route to tools the bridge does not mount — see module docblock.
    for (const block of [lintBlock, pitfallsBlock]) {
      const body = block.render();
      if (body === null) continue;
      sections.push('', fenced(block.heading, body));
    }
  }

  return sections.join('\n');
}
