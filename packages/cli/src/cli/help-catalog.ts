/**
 * Static command help descriptions for top-level and hand-written CLI routes.
 *
 * Method-record help (`pyric <tool> <method> --help`) and the global service
 * tool table are generated directly from the method registry in `help.ts`.
 */

export interface CommandHelpEntry {
  readonly usage: string;
  readonly summary: string;
  readonly details?: readonly string[];
  readonly flags?: readonly [flag: string, description: string][];
  readonly example?: string;
}

export const TOP_LEVEL_COMMANDS: Readonly<Record<string, CommandHelpEntry>> = {
  bridge: {
    usage: 'pyric bridge [--port N] [--project ID] [--session-token] [--allowed-host H] [--allow-remote-peers[=CIDR|any]] [--trust-proxy[=loopback|CIDR]]',
    summary:
      'Start an HTTP MCP server with the rules, conformance, identity, and capture tools. It has no browser socket: for an agent driving a sandbox in a page, run `pyric sandbox --bridge`.',
    flags: [
      ['--port N', 'Port to bind on 127.0.0.1 (0 picks an available port). Default 5174. Env: PYRIC_PORT.'],
      ['--project ID', 'Project label surfaced in /health and audit output. Env: PYRIC_PROJECT.'],
      ['--session-token', 'Require x-pyric-session-token on /mcp and full /health.'],
      ['--allowed-host H[,H...]', 'Additional Host name or leading-dot suffix (.tailnet.ts.net). Env: PYRIC_ALLOWED_HOSTS.'],
      ['--allow-remote-peers[=P]', 'Admit non-loopback TCP peers (CIDR list or any; requires token). Env: PYRIC_ALLOW_REMOTE_PEERS.'],
      ['--trust-proxy[=P]', 'Trust X-Forwarded-Proto/Host from loopback or CIDR proxy hop. Env: PYRIC_TRUST_PROXY.'],
    ],
  },
  run: {
    usage: 'pyric run [--sandbox URL] [--wait[=SECONDS]] -- <command...>',
    summary:
      'Run a command against a sandbox host that is already running (`pyric sandbox --hosted` or Vite `pyric({ hosted: true })`), injecting PYRIC_SANDBOX and the register hook.',
    flags: [
      [
        '--sandbox URL',
        'Host URL of a running hosted sandbox (`pyric sandbox --hosted` or Vite `pyric({ hosted: true })`). Overrides PYRIC_SANDBOX=remote:<url> and .pyric/serve.json.',
      ],
      ['--wait[=SECONDS]', 'Poll host health until it answers before starting the command (default 30s).'],
    ],
  },
  init: {
    usage: 'pyric init [dir] [--template=web|static|node|nextjs] [--name=NAME] [--force] [--json]',
    summary:
      'Scaffold a Pyric project. Never prompts; rerunning is safe. Greenfield shortcut: `npm create pyric [dir]`.',
    flags: [
      ['--template NAME', 'Scaffold template: web (default), static, node, or nextjs.'],
      ['--name NAME', 'Project name written to package.json.'],
      ['--force', 'Overwrite existing scaffold files.'],
      ['--json', 'Print machine-readable JSON on stdout.'],
    ],
  },
  vendor: {
    usage: 'pyric vendor [dir] [--json]',
    summary:
      'Vendor pyric and @pyric/cli tarballs into vendor/ and merge their dependencies into package.json without scaffolding. Standalone binary only.',
    flags: [['--json', 'Print machine-readable JSON on stdout.']],
  },
  mcp: {
    usage: 'pyric mcp [--project-dir DIR] [--in-process] [--attach] [--allow-production] [--surface ID]',
    summary:
      'Stdio MCP server for editors and agents. Serves the ten service tools against a local in-process sandbox or routes per call to a running Node host (`hosted` or `live`), and relays HTTP /__pyric/mcp only for SharedWorker hosts or explicit `--attach`.',
    flags: [
      ['--project-dir DIR', 'Project directory for rules, state, and host discovery (default: cwd; env: PYRIC_PROJECT_DIR).'],
      ['--in-process', 'Force the local in-process sandbox even when a host is running.'],
      ['--attach', 'Require a running host (.pyric/serve.json) and relay directly over HTTP /__pyric/mcp (cannot be combined with --surface or --allow-production).'],
      ['--allow-production', 'Mount production-effect methods (default: refused).'],
      ['--surface ID', 'Select an evaluation tool-surface variant (env: PYRIC_TOOL_SURFACE).'],
    ],
  },
  snapshot: {
    usage: 'pyric snapshot [--out=FILE|DIR] [--port N] [--force] [--json] [--include-passwords]',
    summary:
      'Promote lived sandbox state (live sandbox --persist, hosted state, or .pyric/state/state.json) to a committable JSON file (when --out ends in .json) or directory (state.json plus objects/) that `pyric sandbox --seed` re-serves.',
    flags: [
      ['--out FILE|DIR', 'Destination .json state file, or directory for state.json and objects/.'],
      ['--port N', 'Live sandbox port to snapshot instead of scanning 3473-3477.'],
      ['--force', 'Overwrite an existing snapshot file or directory.'],
      ['--include-passwords', 'Keep user passwords instead of redacting them.'],
      ['--json', 'Print machine-readable JSON on stdout.'],
    ],
  },
  verify: {
    usage: 'pyric verify [fixture|dir] [--engine sandbox|rules-test-api|staging|both] [--service NAME] [--rules S=PATH] [--json]',
    summary:
      'Replay a captured sandbox session (.pyric/last-session.json by default) against candidate Firestore, Realtime Database, and Storage rules. Exits 1 on divergence.',
    details: [
      'Subcommands:',
      '  pyric verify cases [fixture] [--service firestore] [--out FILE]',
      '  pyric verify staging init',
      '  pyric verify staging restore [--force]',
    ],
    flags: [
      ['--engine NAME', 'Verification engine: sandbox (default), rules-test-api, staging, or both.'],
      ['--service NAME', 'Filter verifiable services (firestore, database, storage).'],
      ['--rules S=PATH', 'Override candidate rules path for a service or rtdb:<instance>=PATH.'],
      ['--project ID', 'Firebase project id for Rules Test API verification.'],
      ['--json', 'Print machine-readable JSON on stdout.'],
    ],
  },
  'can-i-use': {
    usage: 'pyric can-i-use <feature> [--json]',
    summary:
      'Report Pyric availability, behavior fidelity, and assurance eligibility from the canonical conformance model. Prefix with a surface such as `firestore-rules/getAfter` to disambiguate.',
    flags: [['--json', 'Print machine-readable JSON on stdout.']],
  },
};

export const MULTI_WORD_COMMANDS: Readonly<Record<string, CommandHelpEntry>> = {
  'sandbox salvage': {
    usage: 'pyric sandbox salvage --source=DIR --out=NEW_DIR',
    summary:
      'Recover readable records from an offline hosted state directory into a separate new directory and write recovery-report.json.',
    flags: [
      ['--source DIR', 'Offline hosted state directory to recover from (required).'],
      ['--out DIR', 'New destination directory for recovered state (required).'],
    ],
  },
  'sandbox seed-from-live': {
    usage: 'pyric sandbox seed-from-live --confirm [--replace] [--json] | --out=FILE [--instance NAME] [--force] [--json]',
    summary:
      'Materialize session-observed Live mode data from a running live host into `.pyric/state/hosted` (`--confirm`) or export it as a seed JSON file (`--out FILE`).',
    flags: [
      ['--confirm', 'Seed the local hosted sandbox state directly (opt-in required).'],
      ['--replace', 'Replace existing hosted sandbox state instead of merging.'],
      ['--out FILE', 'Export observed data as a SandboxSeed JSON file.'],
      ['--instance NAME', 'RTDB instance to export with --out.'],
      ['--force', 'Overwrite an existing --out file.'],
      ['--json', 'Print machine-readable JSON on stdout.'],
    ],
  },
  'verify cases': {
    usage: 'pyric verify cases [fixture] [--service firestore] [--out FILE]',
    summary:
      'Derive Firestore Rules Test API cases from a captured fixture and print JSON, or write to --out FILE.',
    flags: [
      ['--service NAME', 'Service filter (firestore).'],
      ['--out FILE', 'Write derived cases JSON to FILE instead of stdout.'],
    ],
  },
  'verify staging': {
    usage: 'pyric verify staging <init|restore>',
    summary: 'Manage the dedicated staging Realtime Database instance used by `pyric verify --engine staging`.',
    details: [
      'Subcommands:',
      '  pyric verify staging init',
      '  pyric verify staging restore [--force]',
    ],
  },
  'verify staging init': {
    usage: 'pyric verify staging init',
    summary:
      'Enroll the empty RTDB instance named in pyric.json verify.staging ({ project, rtdb }) for --engine staging. Refuses instances with existing data or firebase.json deploy targets.',
  },
  'verify staging restore': {
    usage: 'pyric verify staging restore [--force]',
    summary:
      'Restore the staging RTDB instance rules from .pyric/staging-restore.json after an interrupted run.',
    flags: [['--force', 'Deploy deny-all marker rules when no saved backup exists.']],
  },
  'firestore rules': {
    usage: 'pyric firestore rules <validate|resolve> ...',
    summary: 'Validate or resolve Firestore security rules.',
    details: [
      'Subcommands:',
      '  pyric firestore rules validate <path>',
      '  pyric firestore rules resolve <path> [--out <path>]',
    ],
  },
  'firestore rules validate': {
    usage: 'pyric firestore rules validate <path>',
    summary: 'Validate Firestore rules structure and compile limits against a rules file (supports 2+modules imports).',
  },
  'firestore rules resolve': {
    usage: 'pyric firestore rules resolve <path> [--out <path>]',
    summary: 'Resolve Firestore 2+modules imports into a single standard rules_version 2 ruleset.',
    flags: [['--out PATH', 'Write resolved ruleset to PATH instead of stdout.']],
  },
  'firestore indexes': {
    usage: 'pyric firestore indexes generate <path...> [--out <path>]',
    summary: 'Generate Firestore index definitions from application source.',
  },
  'firestore indexes generate': {
    usage: 'pyric firestore indexes generate <path...> [--out <path>]',
    summary: 'Generate firestore.indexes.json from application source files.',
    flags: [['--out PATH', 'Write firestore.indexes.json to PATH instead of stdout.']],
  },
  'storage rules': {
    usage: 'pyric storage rules resolve <path> [--out <path>]',
    summary: 'Resolve Cloud Storage 2+modules security rules.',
  },
  'storage rules resolve': {
    usage: 'pyric storage rules resolve <path> [--out <path>]',
    summary: 'Resolve Storage 2+modules imports into a single standard rules_version 2 ruleset.',
    flags: [['--out PATH', 'Write resolved ruleset to PATH instead of stdout.']],
  },
  'database rules': {
    usage: 'pyric database rules <validate|generate> ...',
    summary: 'Validate or generate Realtime Database security rules.',
    details: [
      'Subcommands:',
      '  pyric database rules validate <path> [--fail-on <critical|high|medium>]',
      '  pyric database rules generate [--config <path>] [--out <path>] [--fail-on <critical|high|medium>]',
    ],
  },
  'database rules validate': {
    usage: 'pyric database rules validate <path> [--fail-on <critical|high|medium>]',
    summary: 'Validate Realtime Database rules expressions and report findings.',
    flags: [['--fail-on LEVEL', 'Fail with non-zero exit at or above critical, high, or medium severity.']],
  },
  'database rules generate': {
    usage: 'pyric database rules generate [--config <path>] [--out <path>] [--fail-on <critical|high|medium>]',
    summary: 'Compile a constraints module into database.rules.json.',
    flags: [
      ['--config PATH', 'Constraints module path.'],
      ['--out PATH', 'Output path for database.rules.json.'],
      ['--fail-on LEVEL', 'Fail with non-zero exit at or above critical, high, or medium severity.'],
    ],
  },
  'database indexes': {
    usage: 'pyric database indexes generate <path...> [--rules <path>] [--out <path>] [--check] [--instance <name>]',
    summary: 'Extract Realtime Database .indexOn rules from application source.',
  },
  'database indexes generate': {
    usage: 'pyric database indexes generate <path...> [--rules <path>] [--out <path>] [--check] [--instance <name>]',
    summary: 'Extract RTDB .indexOn rules from application source files.',
    flags: [
      ['--rules PATH', 'Existing database.rules.json to merge into or check against.'],
      ['--out PATH', 'Write updated rules to PATH instead of stdout.'],
      ['--check', 'Exit non-zero if any required .indexOn rule is missing.'],
      ['--instance NAME', 'Target RTDB instance name.'],
    ],
  },
  'serve diagnostics': {
    usage: 'pyric serve diagnostics [--url URL] [--json]',
    summary: 'Read bounded startup and connection diagnostic reports from a running host over HTTP.',
    flags: [
      ['--url URL', 'Origin of a running host (otherwise discovered from .pyric/serve.json).'],
      ['--json', 'Print the diagnostic report as JSON.'],
    ],
  },
  'serve sessions': {
    usage: 'pyric serve sessions [--json]',
    summary: 'List clients connected to the running bridge with their target ids, platforms, and active identities.',
    flags: [['--json', 'Print sessions as JSON.']],
  },
  'serve denials': {
    usage: 'pyric serve denials [--json] [--since <ms|duration>] [--service rtdb|firestore]',
    summary: 'List RTDB and Firestore rules denials recorded by the running Node host, grouped by service, instance, and rule.',
    flags: [
      ['--since WINDOW', 'Only include denials within the last duration (e.g. 5m, 30s) or since epoch ms.'],
      ['--service NAME', 'Filter denials to rtdb or firestore.'],
      ['--json', 'Print denials as JSON.'],
    ],
  },
  'serve repro': {
    usage: 'pyric serve repro <capture|replay> ...',
    summary: 'Capture or replay a deterministic host repro file.',
    details: [
      'Subcommands:',
      '  pyric serve repro capture [--out FILE] [--force]',
      '  pyric serve repro replay <file> [--plane node|worker] [--json]',
    ],
  },
  'serve repro capture': {
    usage: 'pyric serve repro capture [--out FILE] [--force]',
    summary: 'Write the running Node host repro file: starting state, rules, signed-in ports, and recorded operations.',
    flags: [
      ['--out FILE', 'Output path (default pyric-repro.json).'],
      ['--force', 'Overwrite an existing output file.'],
    ],
  },
  'serve repro replay': {
    usage: 'pyric serve repro replay <file> [--plane node|worker] [--json]',
    summary: 'Replay a repro file on a fresh Node host and worker host, reporting the first divergence.',
    flags: [
      ['--plane NAME', 'Replay only the node or worker plane.'],
      ['--json', 'Print replay report as JSON.'],
    ],
  },
  'auth reset': {
    usage: 'pyric auth reset [--target ID] [--json]',
    summary: 'Follow the application session again on a running bridge (or reset another connected client with --target).',
    flags: [
      ['--target ID', 'Reset a specific connected client listed by `pyric serve sessions`.'],
      ['--json', 'Print the result as JSON.'],
    ],
  },
  'assurance derive': {
    usage:
      'pyric assurance derive [dir] [--root DIR] [--port N | --url URL] [--campaign-id ID] [--fail-on GATE] [--include-heuristic] [--no-static] [--json]',
    summary:
      'Derive tri-source assurance diagnostics and counterexample probes into a fresh local campaign.',
    flags: [
      ['--port N', 'Loopback port of a running Pyric server to clone.'],
      ['--url URL', 'Loopback HTTP(S) URL of a running Pyric server to clone.'],
      ['--root DIR', 'Project directory to scan (default: cwd; also accepted as positional [dir]).'],
      ['--campaign-id ID', 'Explicit campaign id (generated when omitted).'],
      [
        '--fail-on GATE',
        'Exit 1 gate: proven-counterexample, static-proof, heuristic, critical, high, medium, or low.',
      ],
      ['--include-heuristic', 'Include heuristic findings in the default fail gate.'],
      ['--no-static', 'Skip static query, storage contract, index, and coverage passes.'],
      ['--json', 'Print full JSON result on stdout.'],
    ],
    example: 'pyric assurance derive --campaign-id audit-pass',
  },
};

export const TOOL_EXTRA_SUBCOMMANDS: Readonly<Record<string, readonly [name: string, summary: string][]>> = {
  firestore: [
    ['rules validate <path>', 'Validate Firestore rules structure against a file.'],
    ['rules resolve <path>', 'Resolve Firestore 2+modules imports to one ruleset.'],
    ['indexes generate <path...>', 'Generate firestore.indexes.json from application source.'],
  ],
  database: [
    ['rules validate <path>', 'Validate Realtime Database rules expressions.'],
    ['rules generate', 'Compile a constraints module to database.rules.json.'],
    ['indexes generate <path...>', 'Extract RTDB .indexOn rules from application source.'],
  ],
  storage: [['rules resolve <path>', 'Resolve Storage 2+modules imports to one ruleset.']],
  auth: [['reset', 'Follow the application session again on a running bridge.']],
  sandbox: [
    ['salvage --source=DIR --out=NEW_DIR', 'Recover records from an offline hosted state directory.'],
    ['seed-from-live --confirm | --out=FILE', 'Seed or export observed Live mode data.'],
  ],
};

export const TOOL_EXTRA_FIRST_WORDS: Readonly<Record<string, readonly string[]>> = {
  firestore: ['rules', 'indexes'],
  database: ['rules', 'indexes'],
  storage: ['rules'],
  auth: ['reset'],
  sandbox: ['salvage', 'seed-from-live'],
};

export const SANDBOX_CORE_FLAGS: readonly [flag: string, description: string][] = [
  ['--hosted', 'Run the sandbox directly in this Node process (no browser tab required).'],
  ['--bridge', 'Mount the HTTP MCP bridge at http://<host>:<port>/__pyric/mcp.'],
  ['--port N', 'Port to serve on (default 3473; scans forward if taken).'],
  ['--host HOST', 'Host to bind (default localhost).'],
  ['--project ID', 'Firebase project id or .firebaserc alias.'],
  ['--seed FILE', 'Seed documents, RTDB, and auth users from a JSON seed or snapshot directory.'],
  ['--persist', 'Persist sandbox state to .pyric/state/state.json.'],
  ['--fresh', 'Discard previous persisted state before starting.'],
  ['--permissive', 'Allow unauthenticated RTDB reads/writes when no database.rules.json exists.'],
  ['--session-token', 'Require a per-boot session capability token on all /__pyric/* routes.'],
  ['--ui / --no-ui', 'Open Studio automatically, or disable Studio/docs routes.'],
  ['--no-open', 'Do not auto-open a browser tab.'],
  ['--no-run', 'Start the host without running pyric.json#command.'],
  ['--no-watch', 'Disable rules file hot-reload.'],
  ['--no-capture', 'Disable writing .pyric/last-session.json.'],
  ['--no-cache', 'Rebuild served SDK bundles instead of using ~/.pyric/serve-cache.'],
  ['--allowed-host H', 'Allow extra Host header(s) or leading-dot suffix (.tailnet.ts.net). Env: PYRIC_ALLOWED_HOSTS.'],
  ['--allow-remote-peers[=P]', 'Admit non-loopback TCP peers (CIDR list or any; requires unlock/token). Env: PYRIC_ALLOW_REMOTE_PEERS.'],
  ['--trust-proxy[=P]', 'Trust X-Forwarded-Proto/Host from loopback or CIDR proxy hop. Env: PYRIC_TRUST_PROXY.'],
  ['--json', 'Print one machine-readable JSON line on stdout; move banner to stderr.'],
];
