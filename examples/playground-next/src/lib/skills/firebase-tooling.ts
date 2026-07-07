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

export const playgroundFirebaseAuthModelSkill: SkillDefinition = {
  id: 'playground-firebase-auth-model',
  label: 'Firebase auth',
  icon: 'passkey',
  description:
    'Design or audit sandbox Auth users, provider flows, custom claims, UID data mapping, and rule simulations without building an app.',
  ...FIREBASE_TOOLING_DEFAULTS,
  primarySurface: 'firebase',
  defaultFirebaseSubtab: 'auth',
  brief: [
    'This is Firebase Auth modeling inside Pyric Playground, not an app build. Do not create App.tsx unless explicitly asked.',
    'Auth is identity; rules are authorization. Map users, UIDs, provider states, and custom claims to rules and data.',
    'Use sandbox Auth evidence first: inspect_auth_users, seed_auth_users, rules, data, simulations, tests, traffic, and denials.',
    'Do not fake auth with in-app identity switchers or hardcoded test-user buttons. The Auth tab and sign-in helper own identities.',
    'READ `man playground-firebase-auth-model` before designing or auditing auth behavior.',
  ].join('\n'),
  manTopic: 'playground-firebase-auth-model',
  manSummary: 'sandbox Auth modeling: users, providers, claims, UID data, rules evidence',
  manBody: `PLAYGROUND-FIREBASE-AUTH-MODEL(7)     sandbox Auth modeling

MENTAL MODEL
  Authentication answers who the user is. Security Rules answer what
  that identity may do. In Playground, the Auth tab and auth tools are
  the source of sandbox identities; the app should use real Firebase
  auth APIs only when the user asks for preview UI.

WORKFLOW
  1. Identify identities: anonymous, signed-in, owner, member,
     admin/custom-claim, disabled/deleted, linked-provider, and any
     service/admin fixture.
  2. Inspect or seed sandbox users with inspect_auth_users and
     seed_auth_users. Put custom claims under token fields so rules
     read them through request.auth.token.<name>.
  3. Map UID to data: profile docs, owner fields, membership docs,
     public/private profile fields, and any duplicated display fields.
  4. Cross-check rules: request.auth == null, request.auth.uid, and
     request.auth.token.<name> must line up with the seeded users and
     fixture data.
  5. Verify with focused simulations, workspace tests, traffic, or
     denials. Cover signed-out, owner, other user, member, admin,
     invalid claim, missing profile, disabled/deleted, and sign-out
     cases when relevant.

RULES
  - UID is the stable bridge from Auth to Firestore, RTDB, and Storage.
  - Use custom claims for coarse global roles. Use document data for
    resource membership and ownership.
  - Users must not be able to grant themselves roles or claims through
    writable profile fields.
  - Account creation, sign-in, sign-out, provider linking, and provider
    collision are different states; model them separately when they
    affect data or rules.
  - Admin/server actions bypass rules. Use them only for fixture setup,
    maintenance, or explicitly trusted flows.
  - Pyric is the local sandbox for this work.

OUTPUT SHAPE
  ## Firebase Auth Model
  ### Identity Model
  ### UID And Data Mapping
  ### Claims And Roles
  ### Access Matrix
  ### Seed Users And Fixtures
  ### Verification Evidence
  ### Risks And Next Steps`,
  enhancerShape: [
    '  - The auth identities to model: anonymous, signed-in, owner, member, admin/custom-claim, disabled/deleted, or linked provider.',
    '  - The Firebase resources those identities must access.',
    '  - The UID, profile-doc, custom-claim, and membership data that rules will depend on.',
    '  - The sandbox evidence to produce: users, fixtures, simulations, traffic, tests, or an audit report.',
    '  - The desired output as an auth/rules model, not an app.',
  ].join('\n'),
};

export const playgroundFirestoreQueryIndexesSkill: SkillDefinition = {
  id: 'playground-firestore-query-indexes',
  label: 'Firestore queries',
  icon: 'query_stats',
  description:
    'Design Firestore query shapes, pagination, collection groups, denormalized reads, and composite indexes with firestore_extract_indexes.',
  ...FIREBASE_TOOLING_DEFAULTS,
  primarySurface: 'firebase',
  defaultFirebaseSubtab: 'data',
  brief: [
    'This is Firestore query and index design, not an app build. Do not create App.tsx unless the user explicitly asks.',
    'Inventory each query: path, filters, sort, limit, cursor, listener needs, auth identity, and expected result size.',
    'Rules are not filters. List queries must prove their allowed scope with matching query constraints.',
    'Run firestore_extract_indexes after query code changes. If it returns zero shapes, report that and fix the source shape; never invent index JSON.',
    'READ `man playground-firestore-query-indexes` before finalizing query/index guidance.',
  ].join('\n'),
  manTopic: 'playground-firestore-query-indexes',
  manSummary: 'Firestore queries and indexes: query shape, rules proof, extraction, verification',
  manBody: `PLAYGROUND-FIRESTORE-QUERY-INDEXES(7)   query and index design

MENTAL MODEL
  Firestore query design is an index proof. A good model names what
  the product must read, proves the query is allowed by rules, and
  extracts the composite indexes required by the code.

WORKFLOW
  1. Inventory query intents: screen/report/listener, collection path,
     collection group, filters, orderBy fields, limit, cursor strategy,
     auth identity, and expected result size.
  2. Choose the read shape: direct document, top-level collection,
     subcollection, collection group, denormalized summary, or fanout.
  3. Classify complexity: simple single-field query, composite query,
     array query, cursor/pagination query, collection group query, or
     query that should become a denormalized read.
  4. Prove rules compatibility. A list query is not filtered by rules;
     the query constraints must show it can only return documents the
     identity may read.
  5. Inspect or write query code in modular SDK shape, preferably inside
     a function body: query(collection(...), where(...), orderBy(...)).
     Switch the left workbench to File when editing query code.
  6. Run firestore_extract_indexes after query code changes. If the
     extractor finds zero shapes, do not fabricate indexes; explain
     whether the code was missing, top-level, admin-chain syntax, or no
     query pattern matched.
  7. Handle extractor output: keep the firestore.indexes.json-shaped
     config, review warnings, and address overshootSuspected. Use a
     targeted @firestore-mutex annotation only when mutually exclusive
     branches create extra enumerated shapes.
  8. Verify in Pyric with data, auth identities, simulations, workspace
     tests, traffic, or denials where relevant.

QUERY RULES
  - Model reads first. Slow Firestore apps usually download too many
    documents, not scan too many.
  - Simple queries touch one field; composite queries combine fields or
    filters/order requirements and need explicit index awareness.
  - Arrays need array operators such as array-contains or
    array-contains-any. Avoid awkward map-as-tag shapes unless that is
    the real access pattern.
  - Pagination should use cursors, not ever-growing limits.
  - Subcollections can remove a where clause for single-parent reads.
  - Firestore reads are shallow; document reads do not include
    subcollections.
  - Collection group queries solve cross-parent subcollection reads and
    require index awareness.
  - Denormalization is a spectrum. Duplicate slow-changing display data
    when it removes repeated lookups or impossible joins.
  - Pyric is the local sandbox for this work.

OUTPUT SHAPE
  ## Firestore Query And Index Plan
  ### Query Inventory
  ### Data Shape Decisions
  ### Rules Compatibility
  ### Extracted Indexes
  ### Verification Evidence
  ### Risks And Next Steps`,
  enhancerShape: [
    '  - The Firestore read screens, reports, listeners, or searches to support.',
    '  - The path, filter, sort, limit, cursor, collection group, or denormalized read shape involved.',
    '  - The security-rule scope the query must prove.',
    '  - The expected index extraction or firestore.indexes.json output.',
    '  - The desired output as a query/index plan with verification evidence, not an app.',
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
