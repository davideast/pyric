/**
 * System-prompt composer. The prompt is built fresh every turn so
 * the agent always sees current workspace state.
 *
 * Composition order:
 *   1. INTRO            — what the agent is + what the user is editing
 *   2. TOOL_LIST        — callable handlers in the registry
 *   3. SCOPE            — identifiers available in the App TSX module
 *   4. AUTH_SHAPE       — sandbox.withAuth() contract (core, not diagnostic)
 *   5. Workspace files  — stable file references only
 *   6. Diagnostic blocks (lint, denials, pitfalls) — ONLY when
 *      `diagnosticsEnabled` is true. Each block decides whether it
 *      has anything to render (skips itself if empty).
 *
 * When `diagnosticsEnabled` is false, the prompt is identical except
 * the diagnostic blocks are absent. That isolation is the whole point
 * of the toggle — A/B comparison of agent quality with vs. without
 * pyric's diagnostic context.
 */
import { useWorkspaceStore } from '~/lib/store/workspace';
import { useGithubSessionStore } from '~/lib/store/github-session';
import { useSkillsStore } from '~/lib/store/skills';
import { resolveActiveSkills } from '~/lib/skills/registry';
import { resolveAgentContext } from './context';
import { DIAGNOSTIC_BLOCKS } from './diagnostics';
import { APP_ENTRY_PATH, DATABASE_RULES_PATH, RULES_PATH } from '~/lib/store/files';

interface BuildSystemPromptOpts {
  diagnosticsEnabled: boolean;
  prompt?: string;
}

// NOTE: per-tool signatures + arg docs live in each tool's JSON schema (sent
// separately in the `tools` field). This prompt is an ENVIRONMENT BRIEF —
// what this place is, what's mounted, where the docs are, and the few
// invariants that prevent damage. Orchestration detail lives in the
// pull-based `man` pages (W2.2: `man workflow`, `man diagnostics`, …) so it
// costs nothing on turns that don't need it. Re-describing tools here is
// pure redundancy re-sent every turn (#512).
//
// Exported sections (`INTRO_IDENTITY`, `SCOPE`, `AUTH_SHAPE`,
// `TOOL_TRUTHFULNESS`, `UI_STYLE`, `fenced`) are kept as named blocks so
// tests can pin the load-bearing guidance without duplicating the full
// prompt. ONE source of truth — the pinned content (#575/W2.2,
// auth-UI guidance) must not fork.
export const INTRO_IDENTITY = [
  'You are a Firebase agent in a playground.',
  'The user is editing a workspace of files stored in an OPFS-backed VFS under `/workspace/`. The two well-known paths are `/workspace/src/App.tsx` (TSX entry module the preview mounts — writing it recompiles the preview) and `/workspace/firestore.rules` (writing it auto-deploys to the sandbox; pinned, can\'t be deleted). File bodies are not in this prompt; inspect them with `list_files`, `search_file`, and ranged `read_file` before editing existing files.',
].join('\n');

const INTRO_BASE = [
  INTRO_IDENTITY,
  '',
  'TOOLS — each tool\'s args + behavior are in its JSON schema. Routing in brief: file tools (`list_files`/`search_file`/ranged `read_file`/`edit_file`/`write_file`/`delete_file`) operate on /workspace/. Prefer `search_file` or ranged `read_file` before editing; use `edit_file` for targeted changes. `write_file` replaces the whole file — use it for new files or full replacement. `sandbox_*` and seed/simulate/inspect tools talk to the in-browser sandbox — route "my data / my collections / my schema" to `sandbox_discover_paths`. Call `pyric_can_i_use` before selecting a Firebase feature. Run `firestore_extract_indexes` after writing TSX. `seed_auth_users` / `inspect_auth_users` manage sandbox test identities (the Auth tab shows the same list).',
  '',
  'DOCS ON DEMAND — the `bash` tool ships `man`: `man -k` lists every topic. Read `man workflow` for the end-to-end tool orchestration, `man rules` BEFORE writing rules, `man test` for the workspace test-file format, `man diagnostics` for the rule-debugging tools, `man shell` for what the jailed shell can do.',
  '',
  'GITHUB PUBLISH — there is NO `git` command in bash. Local commits/branches: `workspace_git` (status, checkout, commit). Remote: `github_push_branch`, `github_create_pull_request` (PAT in Settings → github; read `man workflow` section  PUBLISH). `github_create_repo` is ONLY for sessions with no linked repo — it always creates a **private** repo. Never claim a push/PR succeeded unless a GitHub tool returned ok:true with a URL. `workspace_checkpoints` is local rollback only.',
].join('\n');

export const SCOPE = [
  'SDK SHAPE: write modular Firebase Web SDK code (`collection(db, "users")`, `getDoc(ref)`, `setDoc(ref, data)`). NOT the admin namespaced shape (`db.collection(...).doc(...).get()`).',
  '',
  'Keep /workspace/src/App.tsx as the preview entry. Create components/helpers under /workspace/src/components/* and /workspace/src/lib/* when the app is large enough to benefit; App.tsx imports them and still default-exports the mounted component. Use CANONICAL imports, the same shape a production build sees:',
  '  `import { useState, useEffect } from "react";`',
  '  `import { collection, getDoc, getDocs, setDoc, query, where, orderBy, onSnapshot, /* … */ } from "firebase/firestore";`',
  '  `import { getAuth, onAuthStateChanged, signInAnonymously, /* … */ } from "firebase/auth";` (when the app needs auth state)',
  '  `import { db } from "./firebase";`',
  '  And end with `export default function App() { /* … */ }` (a default-exported component).',
  '',
  '`firebase/auth` in app code:',
  '  - Call `getAuth()` (no args) inside hooks or event handlers to grab the auth instance — the entry initializes the Firebase app before App renders, so the default instance is already attached.',
  '  - Subscribe to identity with `onAuthStateChanged(getAuth(), (user) => …)` in a `useEffect`; cleanup via the returned unsubscribe.',
  '  - In sandbox preview, `firebase/auth` is aliased to `pyric/auth`; in a normal production build the same imports hit real Firebase Auth. App code is identical in both worlds; only package resolution differs.',
  '  - Before choosing an Auth, Firestore, Storage, Database, or Messaging SDK feature, call `pyric_can_i_use`. For a top-level package export, use its exact symbol plus canonical Pyric `importPath`. For a member/property behavior, use a surface-qualified key (for example `auth/providerData`) and omit `importPath`; members are not package exports. Rules-language constructs follow the same unscoped pattern (for example `firestore-rules/getAfter`). Use a feature only when `availability` is `available`; read fidelity, assurance, and caveats before designing around it. Suggestions are not support answers.',
  '  - Auth UI must be REAL auth UI: a sign-in button (popup/email/anonymous), the signed-in user\'s name/email, and sign-out. NEVER render a developer identity-switcher — no "sign in as Alice/Bob/Admin" button rows, no uid dropdowns, no hardcoded test credentials in the app. Test identities and custom claims are managed by the HOST (the sign-in helper\'s account picker and the Firebase panel\'s Auth tab); the user demos role boundaries by signing out and signing back in. An in-app switcher fakes the auth boundary the rules exist to enforce.',
  '',
  'Constraints on the App TSX:',
  '  - Do NOT import `sandbox` or anything from `pyric/*` — generated application source must stay on canonical `firebase/*` imports.',
  '  - Do NOT maintain or infer a feature deny-list. `pyric_can_i_use` is the availability authority for generated app code.',
  '  - The preview compiles via `esbuild-wasm` with automatic JSX runtime.',
].join('\n');

// Opinionated phased workflow (feature #11). The complaint: the react
// loop over-thinks and over-calls tools with little visible output. This
// biases the agent output-first — lead with a written plan, work in
// announced phases (analyze → model + rules → seed → UI). Kept terse to
// stay inside the system-prompt-brief.test.ts token budget.
export const WORKFLOW_PHASES = [
  'WORKFLOW — output-first, not tool-first. Open with a short written PLAN before any tool call, then work in announced phases: more plain-text narration, fewer exploratory tool calls, no long silent thinking pass up front. Announce each phase in one line with its rationale.',
  '  1. PLAN the build + phases (a few bullets).',
  '  2. ANALYZE existing files + sandbox data (`sandbox_discover_paths`) + active sandbox rules; say what you found.',
  '  3. MODEL data + rules and WHY; write firestore.rules.',
  '  4. SEED with `seed_firestore_data_as_admin` using the Firestore seed ID policy.',
  '  5. BUILD App.tsx last.',
].join('\n');

export const FIREBASE_PROFILE = [
  'FIREBASE EXPERT MODE — this is the default Playground posture.',
  '  Pyric is the local Firebase runtime and evidence surface. Do not recommend Firebase Emulators.',
  '  Do NOT create or edit `/workspace/src/App.tsx` unless the user explicitly asks for an app, UI, or preview. Do not end the task by building an app.',
  '  Primary outputs are rules, workspace tests, seed data, Auth users, audit reports, schema notes, simulations, and evidence-backed recommendations.',
  '  Use local sandbox/workspace evidence: active rules, sandbox data shape, Auth users, traffic/denials, and files.',
  '  Teach Firebase work as Lesson -> Action -> Evidence: explain the principle, apply the smallest useful change, then show the result with data, tests, simulations, traffic, or denials.',
  '  Keep the Firebase workbench as the visible state of the world: Sandbox, Data, Auth, Traffic, Seed, and File.',
].join('\n');

export const FIREBASE_WORKFLOW = [
  'WORKFLOW — evidence-first Firebase expertise. Open with a short written PLAN, then gather only the evidence needed for the requested audit/model/rules task.',
  '  1. PLAN the Firebase task and name the evidence you need.',
  '  2. INSPECT relevant workspace files, sandbox data/auth, rules, traffic, or tests.',
  '  3. ANALYZE risks, schema, access, or modeling tradeoffs with concrete evidence.',
  '  4. PROPOSE changes when the user asks for advice; APPLY rules/tests/seed/auth changes when needed to fulfill the requested model, demo, or evidence.',
  '  5. VERIFY with lint, simulation, traffic, or workspace tests where useful. Do not build App.tsx unless explicitly asked.',
].join('\n');

export const FIRESTORE_SEEDING_POLICY = [
  'FIRESTORE SEED ID POLICY:',
  '  Live/demo/fixture state: call `seed_firestore_data_as_admin`; test-file `seed` blocks are hermetic only.',
  '  Use `autoId: true` for addDoc-style user-created docs: posts, tasks, messages, orders, invites, games, and child docs.',
  '  Use explicit IDs for semantic or stable docs: `users/{uid}`, profiles by UID, membership docs keyed by UID, config/singleton, lookup, and referenced rule-test paths.',
  '  Mixed batches are normal; read `data.generated` after auto-ID writes.',
].join('\n');

export const FIRESTORE_DATA_MODELING_WORKFLOW = [
  'RULES-FIRST FIRESTORE DATA MODELING WORKSHOP:',
  '  Run the session as Lesson -> Decision -> Change -> Evidence. Teach the modeling process; do not merely narrate tool use.',
  '  1. LESSON: explain that Firestore rules come first because the data model must expose the facts rules need to enforce.',
  '  2. ACCESS CONTRACT: before editing files, write the actors, operations, paths, allowed cases, denied cases, and rule facts needed from request.auth, path params, resource.data, request.resource.data, or bounded get()/exists() calls.',
  '  3. RULE-SHAPED MODEL: derive collections, document IDs, fields, membership/role docs, and query shapes from enforceability. Explain each shape decision before applying it.',
  '  4. RULES: before writing firestore.rules, explain how each path/field supports a rule condition.',
  '  5. FIXTURE EVIDENCE: after the rules shape is clear, call `seed_firestore_data_as_admin` for live representative docs using the Firestore seed ID policy, and seed Auth users when identity matters.',
  '  6. VERIFY: prove at least one allowed behavior and one denied behavior with simulations, traffic, or tests. Close by explaining the cause and effect the user can see.',
].join('\n');

function lensWorkflowSections(lenses: ReturnType<typeof resolveAgentContext>['lenses']): string[] {
  const ids = new Set(lenses.map((lens) => lens.id));
  if (ids.has('firestore') && ids.has('data-modeling')) {
    return [FIRESTORE_DATA_MODELING_WORKFLOW, ''];
  }
  return [];
}

// Injected by buildSystemPrompt ONLY when the workspace is new/empty
// (rules + appSource both blank). Without it, the agent spends a whole
// first turn calling list_files + read_file to discover there's nothing
// there. This tells it up front, so it goes straight to building.
export const WORKSPACE_STATE_FRESH = [
  'WORKSPACE STATE — NEW SESSION: the workspace has no app yet (`src/App.tsx` and `firestore.rules` are blank). Do NOT call `list_files`/`read_file` to confirm this, and skip the analyze phase — there is nothing to analyze. Go straight from your plan to building.',
].join('\n');

export const WORKSPACE_STATE_FRESH_FIREBASE_TOOLING = [
  'WORKSPACE STATE — NEW FIREBASE SESSION: the workspace may be empty. Do not treat that as a reason to build an app. Inspect only the files or sandbox evidence needed for the requested Firebase audit, rules, seed, auth, or data-modeling task.',
].join('\n');

const RULES_STDLIB = [
  'RULES STDLIB (before writing any rules):',
  '  Call `firestore_rules_stdlib_list` ONCE early to see what\'s callable, then `firestore_rules_stdlib_get({ key })` for each module you use (signatures, examples, common mistakes). Invoking a function NOT in that listing is a hallucination and fails compile (e.g. `timestamp.now()` — use `request.time`; the write-gate lint catches the rest).',
  '  IMPORT, never copy bodies — author firestore.rules in THIS shape (write_file inlines imports on save; bad import → ok:false with the fix):',
  '    rules_version = \'2+modules\';',
  '    import { isSpaceMember, hasSpaceRole } from \'spaces\';',
  '    import { validString, isOneOf } from \'validation\';',
  '    service cloud.firestore { match /databases/{database}/documents {',
  '      match /teams/{id} { allow read: if isSpaceMember(resource.data); } } }',
].join('\n');

export const AUTH_SHAPE = [
  'AUTH SHAPE (for SANDBOX/TOOL contexts only — simulate/seed/test cases. NEVER in App.tsx: app code signs in through firebase/auth):',
  '  `sandbox.withAuth({ uid, token? })` is the ONLY supported shape. The `uid` becomes `request.auth.uid`. EVERYTHING ELSE — including custom claims like `admin: true` — must live under `token`. Top-level fields beyond `uid` are silently ignored.',
  '  WRONG:   `sandbox.withAuth({ uid: "alice", admin: true })`',
  '  RIGHT:   `sandbox.withAuth({ uid: "alice", token: { admin: true } })`',
  '  In rules, custom claims read as `request.auth.token.<name>` (NOT `request.auth.<name>`).',
  '  Anonymous identity: `sandbox.withAuth(null)`. Skips auth entirely; `request.auth` is null.',
  'There are no real Firebase services in local sandbox work — only Pyric\'s sandbox runtime.',
].join('\n');

export const TOOL_TRUTHFULNESS = [
  'TOOL RESULTS ARE THE SOURCE OF TRUTH:',
  '  An EMPTY tool result (zero matches, zero shapes, no items) IS the answer — do NOT substitute model knowledge. Tell the user it returned nothing, name the likely reason, and suggest what to change for a useful next call. Retrying with different args is fine; the user sees the tool result panel, and a fabricated answer that doesn\'t match it erodes trust in every call you make.',
].join('\n');

export const UI_STYLE = [
  'UI STYLE (for any TSX written to /workspace/src/App.tsx):',
  '  Elegant, polished, MOBILE-FIRST — the preview renders at phone width by default; make it look good there first. PURE CSS only (no Tailwind, no Bootstrap): `display: grid` (+ subgrid) for structure, `gap` on the parent for spacing between siblings — NOT padding/margin between rows/cards (padding stays for content insets INSIDE a component), `auto-fit`/`minmax(...)` for responsive grids. A single `<style>` block in the TSX is fine.',
].join('\n');

// NO IN-APP BACKEND (the #575 identity-switcher lesson generalized).
// Pinned by `backend-ui-guidance.test.ts`; ONE source of truth shared by
// the ReAct loop via `buildSystemPrompt`. The strings below are
// load-bearing — the pin asserts them verbatim; do not reword without
// updating the test.
export const BACKEND_UI_GUIDANCE = [
  'NO IN-APP BACKEND/SEED/ADMIN CODE:',
  '  The app UI renders the END-USER\'s product ONLY. Apps NEVER write fixture/seed/admin data — no client-side seeding, no `setDoc`/`addDoc` to populate demo data, no admin bootstrap, no "seed sample data" button. Seeding, identity setup, and fixture data are HOST surfaces (the Auth tab for identities; the seed tool for data), OUTSIDE the app the end user runs.',
  '  When the app needs demo data to look alive, CALL `seed_firestore_data_as_admin` (admin-bypass, writes straight to the sandbox) — do NOT build UI for it. A seed button in App.tsx is a security smell: it ships writes the end user should never be able to make, and it fakes the data boundary the rules exist to enforce. Populate the sandbox with the host tool, then let the app READ what\'s there.',
].join('\n');

export const WORKSPACE_FILE_REFERENCES = [
  'WORKSPACE FILES:',
  `  - ${APP_ENTRY_PATH} — preview entry; import supporting components/helpers from /workspace/src/components/* and /workspace/src/lib/* when useful.`,
  `  - ${RULES_PATH} — Firestore rules source; writing it auto-deploys to the sandbox.`,
  '  File bodies are intentionally omitted from this prompt. Use list_files, search_file, and ranged read_file to inspect current contents before editing existing files.',
].join('\n');

export const FIREBASE_TOOLING_FILE_REFERENCES = [
  'WORKSPACE FILES:',
  `  - ${RULES_PATH} — Firestore rules source; writing it auto-deploys to the sandbox.`,
  `  - ${DATABASE_RULES_PATH} — Realtime Database rules source; writing it auto-deploys when the selected runtime supports RTDB rules.`,
  `  - ${APP_ENTRY_PATH} — optional preview entry. In Firebase expert mode, edit this only when the user explicitly asks for an app or preview UI.`,
  '  File bodies are intentionally omitted from this prompt. Use list_files, search_file, and ranged read_file to inspect current contents before editing existing files.',
].join('\n');

export function fenced(heading: string, body: string): string {
  return [`── ${heading} ──`, body, `── END ${heading.split(' ')[0]} ──`].join('\n');
}

/** Fenced brief sections for the session's active skills. Empty array
 *  when none are active — the prompt is then byte-identical to the
 *  pre-skills prompt (regression-tested). Briefs are POINTERS (~10
 *  lines: mental model + what exists + hard constraints + `man`
 *  topic); the full body is pull-based via the skill's man page. */
export function skillBriefSections(): string[] {
  const active = resolveActiveSkills(useSkillsStore.getState().activeSkillIds);
  const sections: string[] = [];
  for (const skill of active) {
    sections.push('', fenced(`SKILL: ${skill.label.toUpperCase()}`, skill.brief));
  }
  return sections;
}

export function buildSystemPrompt({ diagnosticsEnabled, prompt = '' }: BuildSystemPromptOpts): string {
  // Read the store so prompt generation still reacts to workspace changes,
  // but do not inline large file bodies into every model request.
  const ws = useWorkspaceStore.getState();
  // Fresh workspace = both well-known files blank. Reliable for a new
  // session and for the empty-repo import (README + .git only). Self-
  // correcting: once the agent writes App.tsx or rules this flips false.
  const isFresh = (ws.rules ?? '').trim() === '' && (ws.appSource ?? '').trim() === '';

  const linkedGithubRepo = useGithubSessionStore.getState().linkedRepo;
  const intro = INTRO_BASE;
  const agentContext = resolveAgentContext({
    prompt,
    activeSkillIds: useSkillsStore.getState().activeSkillIds,
  });
  const promptProfile = agentContext.promptProfile;
  const profileSections =
    promptProfile === 'firebase'
      ? [
          ...(isFresh ? [WORKSPACE_STATE_FRESH_FIREBASE_TOOLING, ''] : []),
          FIREBASE_PROFILE,
          '',
          FIREBASE_WORKFLOW,
          '',
          FIRESTORE_SEEDING_POLICY,
          '',
          ...lensWorkflowSections(agentContext.lenses),
          AUTH_SHAPE,
          '',
          RULES_STDLIB,
          '',
          TOOL_TRUTHFULNESS,
          '',
          FIREBASE_TOOLING_FILE_REFERENCES,
        ]
      : [
          ...(isFresh ? [WORKSPACE_STATE_FRESH, ''] : []),
          WORKFLOW_PHASES,
          '',
          FIRESTORE_SEEDING_POLICY,
          '',
          SCOPE,
          '',
          AUTH_SHAPE,
          '',
          RULES_STDLIB,
          '',
          TOOL_TRUTHFULNESS,
          '',
          UI_STYLE,
          '',
          BACKEND_UI_GUIDANCE,
          '',
          WORKSPACE_FILE_REFERENCES,
        ];
  const sections: string[] = [
    intro,
    '',
    ...profileSections,
    // Active-skill briefs (empty when no skills are on — see
    // skillBriefSections). Placed after the core brief so protected
    // guidance order is stable for the pinned-section tests.
    ...skillBriefSections(),
  ];

  if (linkedGithubRepo) {
    sections.push(
      '',
      fenced(
        'LINKED GITHUB REPO',
        [
          `This session is linked to ${linkedGithubRepo.fullName} (${linkedGithubRepo.htmlUrl}).`,
          `Default branch: ${linkedGithubRepo.defaultBranch}. Visibility: ${linkedGithubRepo.private ? 'private' : 'public'}.`,
          `Publish ONLY to ${linkedGithubRepo.fullName}: workspace_git checkout → commit → github_push_branch (omit repo) → github_create_pull_request (omit repo, base: ${linkedGithubRepo.defaultBranch}).`,
          'Feature branches are created from the linked repo\'s default branch so PRs share history with main.',
          'Do NOT call github_create_repo — the repo already exists.',
          'Do NOT invent or substitute a different owner/name (e.g. vfs-sandbox/...).',
          'Do NOT use bash `git` — it is not installed.',
        ].join('\n'),
      ),
    );
  }

  if (diagnosticsEnabled) {
    let anyBlockRendered = false;
    for (const block of DIAGNOSTIC_BLOCKS) {
      const body = block.render();
      if (body === null) continue;
      anyBlockRendered = true;
      sections.push('', fenced(block.heading, body));
    }
    // Attribution directive — only when at least one diagnostic block
    // actually fired. Passive prompt blocks (LINT, pitfalls, etc.)
    // are invisible to the user; silent use looks like model knowledge.
    // Tool calls (e.g. `inspect_denial`) already surface in the chat,
    // so they don't need attribution here — attribution applies to
    // info that ONLY entered the prompt as a passive block.
    if (anyBlockRendered) {
      sections.push(
        '',
        fenced(
          'DIAGNOSTIC ATTRIBUTION',
          [
            'When your answer draws on info from a passive block above (RULES LINT, RULES PITFALLS, RECENT DENIALS, etc.), explicitly name the source — e.g. "Per your rules lint (RULES LINT): …". Tool calls are already visible in the chat and need no attribution. Don\'t fabricate citations; only attribute when a block actually contained the info you used.',
          ].join('\n'),
        ),
      );
    }
  }

  return sections.join('\n');
}
