const NAV_ALIASES: Record<string, string> = {
  'pyric-cli-tutorials-wire-claude-code': 'Wire Claude Code',
  'pyric-rules-how-to-test-rules-against-firebase': 'Test rules against Firebase',
  'pyric-cli-how-to-promote-sandbox-state-to-a-fixture': 'Promote sandbox state',
  'pyric-sandbox-how-to-pick-an-adapter': 'Pick an adapter',
  'pyric-cli-how-to-verify-against-a-captured-session': 'Verify rules',
  'pyric-sandbox-explanation-local-backend-vs-firestore-offline': 'Local backend vs. offline',
  'pyric-sandbox-how-to-multiple-isolated-sandboxes': 'Run isolated sandboxes',
  'pyric-database-explanation-rules-authoring-and-deploy-are-separate': 'Authoring vs. deploy',
  'pyric-firestore-how-to-build-queries': 'Build queries',
  'pyric-rules-how-to-pin-request-time': 'Pin request.time',
  'pyric-storage-how-to-switch-backends': 'Switch backends',
  'ui-traffic-trafficlog': 'TrafficLog components',
  'pyric-admin-firestore-explanation-error-translation': 'Error translation',
  'pyric-admin-firestore-how-to-use-onsnapshot': 'Use onSnapshot',
  'pyric-database-tutorials-01-author-rtdb-rules-with-constraints': 'Author RTDB rules',
  'pyric-sandbox-explanation-why-adapters-are-siblings': 'Why adapters are siblings',
  'pyric-firestore-explanation-rules-tooling-is-separate': 'Rules tooling is separate',
  'pyric-admin-firestore-how-to-translate-denials': 'Translate denials',
  'pyric-storage-how-to-test-rule-expressions': 'Test rule expressions',
  'pyric-admin-firestore-tutorials-01-first-admin-session': 'First admin session',
  'pyric-rules-how-to-compare-rulesets-for-weakening': 'Compare rulesets',
  'pyric-rules-how-to-register-tools-with-an-agent': 'Register rules tools',
  'pyric-sandbox-how-to-use-admin-reads': 'Use admin reads',
  'pyric-cli-how-to-serve-persistence-and-multi-tab': 'Persistence & multi-tab',
  'pyric-firestore-how-to-migrate-from-firebase-firestore': 'Use in existing code',
  'pyric-rules-explanation-agent-failure-modes': 'Agent failure modes',
  'pyric-rules-explanation-sentinel-expression-engine': 'Sentinel expression engine',
  'pyric-cli-how-to-use-the-vite-plugin': 'Use the Vite plugin',
  'ui-auth-authsigninhelper': 'AuthSignInHelper',
  'pyric-sandbox-explanation-listener-re-evaluation': 'Listener re-evaluation',
  'pyric-sandbox-how-to-replay-events': 'Replay events',
  'pyric-storage-tutorials-01-upload-and-download': 'Upload and download',
  'pyric-firestore-compat': 'Conformance matrix',
  'pyric-rules-explanation-lint-vs-validate-vs-simulate-vs-test': 'Lint vs validate vs test',
  'pyric-rules-how-to-inspect-rules-via-the-ast': 'Inspect rules via the AST',
  'pyric-sandbox-explanation-identity-is-a-context': 'Identity is a context',
  'pyric-firestore-explanation-two-backends-one-surface': 'Two backends, one surface',
  'pyric-rules-explanation-runtime-budget-and-shared-gates': 'Runtime budget and gates',
  'pyric-rules-reference-simulator-context': 'Simulator context',
  'pyric-firestore-explanation-target-symbol-opacity': 'TARGET_SYMBOL opacity',
  'pyric-firestore-how-to-pick-a-backend': 'Pick a backend',
  'pyric-firestore-how-to-use-sandbox-ops': 'Use sandbox-only ops',
  'pyric-sandbox-how-to-seed-data-and-rules': 'Seed data and rules',
  'pyric-sandbox-reference-sandbox-and-context': 'Sandbox and context',
  'pyric-storage-compat': 'Conformance matrix',
  'pyric-rules-compat': 'Conformance matrix',
  'pyric-firestore-tutorials-02-swap-to-prod-backend': 'Swap to prod backend',
  'pyric-rules-tutorials-02-write-a-test-suite-for-your-rules': 'Write a rules test suite',
  'pyric-sandbox-how-to-switch-users': 'Switch users',
  'pyric-sandbox-tutorials-02-use-the-sandbox-in-a-test-harness': 'Sandbox in a test harness',
  'pyric-database-compat': 'Conformance matrix',
  'pyric-rules-how-to-resolve-module-imports': 'Resolve 2+modules imports',
  'pyric-auth-compat': 'Conformance matrix',
  'pyric-ai-compat': 'Conformance matrix',
  'pyric-sandbox-reference-snapshot-and-admin': 'Snapshot and admin reads',
  'pyric-cli-how-to-build-a-standalone-binary': 'Build a standalone binary',
  'pyric-admin-firestore-explanation-per-call-delegate': 'Per-call delegate',
  'pyric-admin-firestore-explanation-why-mirror-admin-shape': 'Why mirror the admin SDK',
  'pyric-sandbox-explanation-internal-adapter-protocol': 'The /internal protocol',
  'pyric-sandbox-reference-internal-protocol': 'The /internal protocol',
  'pyric-storage-how-to-list-and-delete': 'List and delete objects',
  'pyric-rules-how-to-simulate-rules-locally': 'Simulate rules locally',
  'pyric-sandbox-how-to-observe-events': 'Observe sandbox events',
};

const STRIP_PREFIXES = [/^How to /i, /^Use the /i, /^Use /i, /^Build a /i, /^Set up /i, /^Write a /i];

export function navLabelFor(slug: string, title: string): string {
  const alias = NAV_ALIASES[slug];
  if (alias) return alias;
  let short = title.split(' — ')[0].split(': ')[0].trim();
  for (const pattern of STRIP_PREFIXES) {
    if (!pattern.test(short)) continue;
    short = short.replace(pattern, '').trim();
    short = short.charAt(0).toUpperCase() + short.slice(1);
    break;
  }
  return short;
}
