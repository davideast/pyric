/**
 * Tool registry composer. Returns a fresh `ToolRegistry` per call —
 * cheap, and the session host wants a stable snapshot per submit so
 * the agent's tool list is consistent across the turn.
 *
 * Composition rule:
 *   - `CORE_TOOLS` (from `./core/`) — always registered. The agent
 *     can't function against the sandbox without these.
 *   - Diagnostic tools (from `./diagnostics/`) — registered when
 *     `useSettingsStore.pyricDiagnosticsEnabled` is true AND the
 *     per-tool flag in `diagnosticToolsEnabled` is on (per-tool flags
 *     default to true). User-facing A/B knob for pyric's diagnostic
 *     layer; per-tool knobs let users isolate the contribution of
 *     each diagnostic.
 *
 * Adding a new tool: register it in `DIAGNOSTIC_TOOL_MANIFEST` under
 * `./diagnostics/index.ts`. The Settings modal and the registry both
 * pick it up from there.
 */
import { createToolRegistry, type ToolHandler, type ToolRegistry } from '@inbrowser/agent';
import { workspaceCheckpointsHandler } from '~/lib/checkpoints/tool';
import { isDiagnosticToolEnabled, useSettingsStore } from '~/lib/store/settings';
import { CORE_TOOLS } from './core';
import { AUTH_TOOLS } from './auth';
import { GITHUB_TOOLS } from './git';
import { workspaceGitHandler } from './git/workspaceGit';
import { DIAGNOSTIC_TOOL_MANIFEST, getDiagnosticTools } from './diagnostics';
import { resolveActiveSkills } from '~/lib/skills/registry';
import { useSkillsStore } from '~/lib/store/skills';

/** Tool handlers contributed by the session's ACTIVE skills (see
 *  lib/skills/registry.ts). Evaluated at call time so a chip toggle
 *  takes effect on the next submit — same posture as diagnostics.
 *  Skill tools bypass the profile allowlists: activation IS the gate. */
function getActiveSkillTools(): ToolHandler[] {
  const out: ToolHandler[] = [];
  for (const skill of resolveActiveSkills(useSkillsStore.getState().activeSkillIds)) {
    if (skill.tools) out.push(...skill.tools());
  }
  return out;
}

export type ToolProfile = 'draft' | 'authoring' | 'diagnostic';

const DRAFT_TOOL_NAMES = new Set([
  'list_files',
  'search_file',
  'read_file',
  'sandbox_discover_paths',
  'simulate_firestore_write',
  'seed_firestore_data_as_admin',
]);

const AUTHORING_TOOL_NAMES = new Set([
  'list_files',
  'search_file',
  'read_file',
  'edit_file',
  'write_file',
  'delete_file',
  'run_workspace_tests',
  'firestore_extract_indexes',
  'firestore_rules_stdlib_list',
  'firestore_rules_stdlib_get',
  // firestore_resolve_modules is deliberately NOT allowlisted (epic
  // #787): resolution is a COMPILE step the write_file gate performs
  // invisibly, not an agent action. Exposing it returned the full
  // inlined ruleset into context (token bomb) and taught agents to
  // edit the expanded output — ejecting from the 2+modules system the
  // stdlib exists to power.
  'sandbox_discover_paths',
  'inspect_denial',
  'inspect_auth_users',
  'seed_auth_users',
  'seed_firestore_data_as_admin',
  'workspace_checkpoints',
  'bash',
  // Git / GitHub publish tools. Registered in buildToolRegistry() but
  // were missing from every profile allowlist, so filterToolsForProfile
  // dropped them and the agent never saw them (bug: "Git tools are not
  // available"). They self-gate at execution on PAT + linked-repo, so
  // allowlisting them here is safe.
  'workspace_git',
  'github_create_repo',
  'github_push_branch',
  'github_create_pull_request',
]);

export function filterToolsForProfile(
  tools: readonly ToolHandler[],
  profile: ToolProfile,
): ToolHandler[] {
  if (profile === 'diagnostic') return tools.slice();
  const wanted = profile === 'draft' ? DRAFT_TOOL_NAMES : AUTHORING_TOOL_NAMES;
  return tools.filter((t) => wanted.has(t.name));
}

export interface ToolRegistrationOptions {
  forceDiagnostics?: boolean;
}

function shouldRegisterDiagnostics(
  settings: ReturnType<typeof useSettingsStore.getState>,
  options?: ToolRegistrationOptions,
): boolean {
  return options?.forceDiagnostics === true || settings.pyricDiagnosticsEnabled;
}

export function listToolHandlersForCurrentSettings(
  options?: ToolRegistrationOptions,
): ToolHandler[] {
  const settings = useSettingsStore.getState();
  const tools: ToolHandler[] = [
    ...(CORE_TOOLS as readonly ToolHandler[]),
    ...(AUTH_TOOLS as readonly ToolHandler[]),
    workspaceCheckpointsHandler as ToolHandler,
  ];
  if (shouldRegisterDiagnostics(settings, options)) {
    tools.push(...getDiagnosticTools());
  }
  return tools;
}

export function listToolHandlersForProfile(
  profile: ToolProfile,
  options?: ToolRegistrationOptions,
): ToolHandler[] {
  // Skill tools append AFTER the profile filter — the user's explicit
  // activation is the gate, not the profile allowlist.
  return [
    ...filterToolsForProfile(listToolHandlersForCurrentSettings(options), profile),
    ...getActiveSkillTools(),
  ];
}

export function buildToolRegistry(options?: ToolRegistrationOptions): ToolRegistry {
  const registry = createToolRegistry();
  for (const t of CORE_TOOLS) registry.register(t);
  // Sandbox auth user-admin twins of the Auth tab (B3.2) — always on.
  for (const t of AUTH_TOOLS) registry.register(t);
  registry.register(workspaceCheckpointsHandler as ToolHandler); // W3.1 — always-on, beside CORE_TOOLS
  registry.register(workspaceGitHandler as ToolHandler);
  for (const t of GITHUB_TOOLS) registry.register(t);
  const settings = useSettingsStore.getState();
  let diagnosticNames: string[] = [];
  const disabledByUser: string[] = [];
  if (shouldRegisterDiagnostics(settings, options)) {
    // `getDiagnosticTools()` evaluates auth + project state AND
    // per-tool flags at call time, so signing in mid-session or
    // flipping a per-tool toggle takes effect on the next submit.
    const diags = getDiagnosticTools();
    for (const t of diags) registry.register(t);
    diagnosticNames = diags.map((d) => d.name);
    for (const entry of DIAGNOSTIC_TOOL_MANIFEST) {
      if (!isDiagnosticToolEnabled(settings, entry.key)) {
        disabledByUser.push(entry.key);
      }
    }
  }
  // Active-skill tools — the user's chip toggle is the gate.
  const skillTools = getActiveSkillTools();
  for (const t of skillTools) registry.register(t);
  // Surface registration outcome to the browser console so the user
  // can verify which tools the agent will see this turn.
  if (typeof window !== 'undefined') {
    console.info(
      '[tools] registered:',
      [...CORE_TOOLS, ...AUTH_TOOLS, workspaceCheckpointsHandler, workspaceGitHandler, ...GITHUB_TOOLS].map((t) => t.name).join(', '),
      diagnosticNames.length > 0
        ? `+ diagnostic: ${diagnosticNames.join(', ')}`
        : options?.forceDiagnostics === true
          ? '(no diagnostic tools — unavailable in this context)'
          : '(no diagnostic tools — sign in + pick a project to enable)',
      disabledByUser.length > 0
        ? `| user-disabled: ${disabledByUser.join(', ')}`
        : '',
      skillTools.length > 0 ? `+ skill: ${skillTools.map((t) => t.name).join(', ')}` : '',
    );
  }
  return registry;
}
