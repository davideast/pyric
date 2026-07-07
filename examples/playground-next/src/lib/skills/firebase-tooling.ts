import type { SkillDefinition } from './registry';
import { DATABASE_RULES_PATH, RULES_PATH } from '~/lib/store/files';

const FIREBASE_TOOLING_DEFAULTS = {
  promptProfile: 'firebase-tooling',
  toolProfilePreference: 'diagnostic',
  strategyPreference: 'react',
} as const;

export const firebaseAuditSkill: SkillDefinition = {
  id: 'firebase-audit',
  label: 'Firebase audit',
  icon: 'manage_search',
  description:
    'Audit the current sandbox/workspace Firebase state for security, data-shape, auth, and rules gaps without building an app.',
  ...FIREBASE_TOOLING_DEFAULTS,
  primarySurface: 'firebase',
  defaultFirebaseSubtab: 'sandbox',
  brief: [
    'This is a local Firebase sandbox/workspace audit, not an app build. Do not create App.tsx unless the user explicitly asks.',
    'Answer three questions: who can access what, what data/auth/rules exist, and where rules/data/auth do not line up.',
    'Use evidence from the Firebase workbench and local tools first: sandbox data shape, Auth users, active rules, traffic/denials, and workspace files.',
    'Prioritize findings by severity. Root/public writes and auth bypasses outrank style or structure observations.',
    'READ `man firebase-audit` before compiling the report.',
  ].join('\n'),
  manTopic: 'firebase-audit',
  manSummary: 'local sandbox/workspace audit: security, structure, auth, rules cross-check',
  manBody: `FIREBASE-AUDIT(7)              local sandbox/workspace audit

MENTAL MODEL
  Audit the current Playground sandbox and workspace, not production
  Firebase. The report answers:
    1. Who can access what?
    2. What data/auth/rules are present?
    3. Do rules, data shape, traffic, and auth users agree?

WORKFLOW
  1. Inspect current workspace files and active rules only as needed.
  2. Inspect sandbox data shape, Auth users, and traffic/denials.
  3. Cross-reference: data paths without meaningful rules, rules with no
     matching data, writes without validation, missing identities for
     claimed auth boundaries, and repeated denials.
  4. Report findings by severity: critical, high, medium, low.

REPORT SHAPE
  ## Firebase Sandbox Audit
  ### Summary
  ### Critical Findings
  ### High Findings
  ### Medium Findings
  ### Low Findings
  ### Positive Observations
  ### Recommended Next Steps

CONSTRAINTS
  Read-only unless the user asks for remediation. Do not build an app.
  Do not claim production coverage in V1; this audit is local sandbox
  and workspace evidence only.`,
  enhancerShape: [
    '  - The current Firebase sandbox/workspace area to audit: rules, data, auth users, traffic, or all of them.',
    '  - The security or correctness concern to prioritize.',
    '  - Evidence to inspect before reporting, such as rules files, sandbox data shape, denials, or Auth users.',
    '  - The desired output as a prioritized audit report, not an app.',
    '  - Whether remediation should be proposed only or applied after the audit.',
  ].join('\n'),
};

export const firestoreRulesAuditSkill: SkillDefinition = {
  id: 'firestore-rules-audit',
  label: 'Firestore rules audit',
  icon: 'policy',
  description:
    'Audit Firestore rules for public access, semantic errors, unsafe composition, missing validation, and test gaps.',
  ...FIREBASE_TOOLING_DEFAULTS,
  primarySurface: 'file',
  defaultFilePath: RULES_PATH,
  defaultFirebaseSubtab: 'traffic',
  brief: [
    'This is a Firestore Rules audit, not an app build. Start from `/workspace/firestore.rules` and local sandbox evidence.',
    'Analyze who can do what, whether operation contexts are semantically valid, and whether match blocks compose safely.',
    'Cross-reference findings: public write + no validation, recursive wildcards + specific rules, undefined calls + unused near-match functions.',
    'Use simulations/tests/traffic when useful; keep the report prioritized and evidence-based.',
    'READ `man firestore-rules-audit` before producing findings.',
  ].join('\n'),
  manTopic: 'firestore-rules-audit',
  manSummary: 'Firestore rules audit: access, semantics, composition, validation gaps',
  manBody: `FIRESTORE-RULES-AUDIT(7)       local Firestore rules audit

MENTAL MODEL
  Audit Firestore rules by answering: who can do what, do rule
  expressions work in their operation context, and do match blocks
  compose safely?

WHAT TO CHECK
  - Public writes or broad write grants.
  - Public reads on sensitive paths.
  - Missing auth checks on create/update/delete.
  - Missing validation for user-controlled writes.
  - get/list confusion: list cannot rely on one document's resource.data.
  - create/update confusion: create uses request.resource.data.
  - Undefined functions, unused functions, near-miss names, expensive
    get()/exists() composition, recursive wildcard bypasses.

WORKFLOW
  1. Read /workspace/firestore.rules with ranged reads as needed.
  2. Use lint, simulate, traffic, and tests when they can provide evidence.
  3. Group by critical/high/medium/low, then explain evidence and fix.
  4. If asked to remediate, change rules first, then run simulations or
     workspace tests. Do not build App.tsx unless explicitly requested.

REPORT SHAPE
  ## Firestore Rules Audit
  ### Summary
  ### Findings
  ### Positive Observations
  ### Recommended Fixes`,
  enhancerShape: [
    '  - The Firestore rules file or rules concern to audit.',
    '  - The operations and identities that matter: get/list/create/update/delete, anonymous, owner, admin, member.',
    '  - The evidence expected: lint, simulations, traffic, tests, or manual review.',
    '  - The output as a prioritized rules audit with fixes, not an app.',
    '  - Whether remediation should be proposed or applied after findings.',
  ].join('\n'),
};

export const rtdbSecurityRulesSkill: SkillDefinition = {
  id: 'rtdb-security-rules',
  label: 'RTDB rules',
  icon: 'rule',
  description:
    'Design or audit Realtime Database security rules, including cascading access, validation, auth, and data/newData semantics.',
  ...FIREBASE_TOOLING_DEFAULTS,
  primarySurface: 'file',
  defaultFilePath: DATABASE_RULES_PATH,
  defaultFirebaseSubtab: 'sandbox',
  brief: [
    'This is Realtime Database rules work, not an app build. Focus on `/workspace/database.rules.json` and local sandbox requirements.',
    'RTDB rules cascade: an allowed ancestor grants descendants. Lock root, then open exact paths.',
    'Use `.write` for WHO can write and `.validate` for WHAT shape is allowed. Use `data` for pre-write actor/context and `newData` for post-write state.',
    'Simulate positive, negative, cross-user, and invalid-shape cases before calling a ruleset done.',
    'READ `man rtdb-security-rules` before authoring or auditing rules.',
  ].join('\n'),
  manTopic: 'rtdb-security-rules',
  manSummary: 'Realtime Database rules: cascading, auth, validation, data vs newData',
  manBody: `RTDB-SECURITY-RULES(7)        Realtime Database rules

MENTAL MODEL
  RTDB rules are JSON expressions. .read and .write cascade downward:
  a permissive parent cannot be revoked by a restrictive child.

RULE TYPES
  .read      controls who can read.
  .write     controls who can write.
  .validate  controls what written data may look like after .write allows.

CORE RULES
  - Lock root by default.
  - Open the smallest useful path.
  - Use auth !== null before auth.uid checks for clarity.
  - Add validation for every user-controlled write path.
  - Use data for pre-write state and newData for post-write state.
  - In multi-field writes, validations see the full merged newData.

WORKFLOW
  1. Identify paths and required identities.
  2. Design access and validation together.
  3. Test positive, anonymous denied, cross-user denied, and invalid
     shape denied.
  4. Write the full database.rules.json file; it replaces the ruleset.
  5. Do not build App.tsx unless the user asks for a preview app.`,
  enhancerShape: [
    '  - The RTDB paths to protect and the identities or roles involved.',
    '  - The read/write/validate behavior required at each path.',
    '  - The invalid writes that must be denied.',
    '  - The expected output as RTDB rules plus simulations/tests, not an app.',
    '  - Any cascading parent/child risks to pay special attention to.',
  ].join('\n'),
};

export const rtdbDataModelSkill: SkillDefinition = {
  id: 'rtdb-data-model',
  label: 'RTDB data model',
  icon: 'account_tree',
  description:
    'Model Realtime Database data structures with flat paths, fan-out writes, indexes, query constraints, and rule implications.',
  ...FIREBASE_TOOLING_DEFAULTS,
  primarySurface: 'file',
  defaultFilePath: DATABASE_RULES_PATH,
  defaultFirebaseSubtab: 'data',
  brief: [
    'This is Realtime Database data modeling, not an app build. Focus on path architecture, query needs, fan-out, indexes, and rules implications.',
    'RTDB is one JSON tree: reading a path downloads everything below it, so flatten entities and design paths as the API.',
    'Optimize for reads with top-level collections, index tables, denormalized summaries, push IDs, and multi-path fan-out writes.',
    'Call out god nodes, deep nesting, array-shaped numeric keys, missing indexes, and normalized SQL-shaped designs.',
    'READ `man rtdb-data-model` before recommending a structure.',
  ].join('\n'),
  manTopic: 'rtdb-data-model',
  manSummary: 'RTDB modeling: flattening, fan-out, indexes, query-shaped paths',
  manBody: `RTDB-DATA-MODEL(7)            Realtime Database data modeling

MENTAL MODEL
  RTDB is one JSON tree. Every path is an API endpoint, and reading a
  path downloads everything below it. Structure determines security,
  performance, pagination, and query shape.

GOOD DEFAULTS
  - Top-level flat entity collections.
  - Index tables for reverse lookups.
  - Denormalized summaries for list screens.
  - Push IDs for append-only lists.
  - Multi-path fan-out writes for consistency.
  - .indexOn rules for queried child fields.

ANTI-PATTERNS
  - Deep nesting under users or entities.
  - Arrays with sequential numeric keys.
  - God nodes every client reads.
  - SQL-style normalization that requires joins.
  - Multiple-field filters with no query-shaped collection.

WORKFLOW
  1. Identify read screens and query order/filter needs.
  2. Design paths around those reads.
  3. Add fan-out write plan for duplicated data.
  4. Explain security-rules implications.
  5. Produce a path map and seed example; do not build App.tsx unless
     the user explicitly asks.`,
  enhancerShape: [
    '  - The product/domain data that needs an RTDB structure.',
    '  - The read screens and query patterns to optimize for.',
    '  - The write/update flows that need fan-out or denormalized summaries.',
    '  - The rules/index implications to consider.',
    '  - The output as a path model and seed/rules plan, not an app.',
  ].join('\n'),
};
