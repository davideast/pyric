/**
 * `pyric deploy [target]` — thin wrapper over `pyric-tools/deploy`'s
 * programmatic surface. Reads `firebase.json` for paths (rules /
 * indexes / hosting); resolves the project id from `--project` /
 * `PYRIC_PROJECT` / `.firebaserc`; resolves a service-account scope
 * from env.
 *
 * Supported targets: `rules`, `indexes`, `hosting`, `functions`.
 * `functions` requires `--source <dir>` and a JSON-formatted
 * `--config` (FunctionDeployConfig[]); this is the minimum to make
 * the CLI a real handle on the library — extras (multi-function
 * config files, watch mode, etc.) land in follow-ups.
 *
 * Every handler returns an exit code so the dispatcher can `process.exit`
 * with the correct value:
 *   0 — deploy succeeded
 *   1 — usage error (bad/missing flag, no firebase.json, …)
 *   2 — runtime / API error (auth failed, API non-2xx, …)
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ToolHandler } from '@inbrowser/agent';
import {
  createFirestoreDeployTools,
  createHostingDeployTools,
  createFunctionsDeployTools,
  type ProjectScope,
} from '../deploy/index.js';
import type { ParsedArgs } from './parse-args.js';
import { readFirebaseJson, readFirebaseRc, type FirebaseJson } from './firebase-json.js';
import { resolveScope } from './scope.js';
import { ensureScope } from '../credentials/node/ensure-scope.js';
import type { Authorizer, CredentialStore, OAuthClient } from '../credentials/core/types.js';
import { providerByTarget } from '../deploy/registry.js';
import { ensureApisEnabled, type EnsureApisResult } from '../deploy/api-enablement.js';
import type { ConfigSource, DeployProvider, DeployToolContext } from '../deploy/provider.js';
import { createDeployReporter } from './deploy-progress.js';

/**
 * Injectable deps so the CLI test suite can verify the dispatch
 * without touching disk / network. Defaults call the real libs.
 */
export interface DeployDeps {
  readFirebaseJson?: (cwd: string) => Promise<FirebaseJson>;
  readFirebaseRc?: typeof readFirebaseRc;
  resolveScope?: (opts: {
    projectId?: string;
  }) => Promise<{ scope: ProjectScope; source: string; grantedScopes?: string[] | 'all' }>;
  /** Scope-upgrade preflight injection (tests). */
  loginAuthorizer?: Authorizer;
  credentialStore?: CredentialStore;
  oauthClient?: OAuthClient;
  /** API-enablement preflight injection (tests). Defaults to the real
   *  Service Usage detect/enable. */
  ensureApis?: typeof ensureApisEnabled;
  readFile?: typeof readFile;
  createFirestoreDeployTools?: typeof createFirestoreDeployTools;
  createHostingDeployTools?: typeof createHostingDeployTools;
  createFunctionsDeployTools?: typeof createFunctionsDeployTools;
  /**
   * Current git branch resolver for `--channel auto` — used in tests.
   * Defaults to `git rev-parse --abbrev-ref HEAD`. Resolves `null`
   * when git is unavailable / not a repo; `'HEAD'` means detached.
   */
  getGitBranch?: (cwd: string) => Promise<string | null>;
  /** Override cwd — used in tests. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override stdout / stderr — used in tests. */
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

// ─── Agent I/O seam (A6) ─────────────────────────────────────────────
//
// The ToolHandler IS the schema — no hand-authored copy. Three knobs,
// generic over deploy targets:
//   --schema           print the tool's `parameters` JSON Schema, exit 0
//   --json '<payload>' validate against that schema, feed the handler
//                      DIRECTLY (firebase.json / hosting flags are
//                      bypassed; project + credential resolution still
//                      applies), print {ok, summary, data} as JSON
//   --json             (bare) machine output for a normal resolved deploy
//                      (mirror of firebase-tools' global -j/--json,
//                      clones/firebase-tools/src/index.ts:16)
// Every deploy target wraps a ToolHandler, so adding one = one entry
// here. Hosting is wired today; rules/indexes/functions are follow-ups.
interface AgentIoEntry {
  toolName: string;
  tools(deps: DeployDeps, scope: ProjectScope): ToolHandler[];
}

const AGENT_IO: Record<string, AgentIoEntry | undefined> = {
  hosting: {
    toolName: 'hosting_deploy',
    tools: (deps, scope) =>
      (deps.createHostingDeployTools ?? createHostingDeployTools)({ scope }),
  },
};

export async function runDeploy(parsed: ParsedArgs, deps: DeployDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const fjRead = deps.readFirebaseJson ?? readFirebaseJson;
  const rcRead = deps.readFirebaseRc ?? readFirebaseRc;
  const resolveScopeFn = deps.resolveScope ?? resolveScope;
  const readFileFn = deps.readFile ?? readFile;

  const targets = [...providerByTarget.keys()];
  const target = parsed.positional[0];
  if (!target) {
    err.write(`pyric deploy: missing target. Usage: pyric deploy <${targets.join('|')}>\n`);
    return 1;
  }
  const provider = providerByTarget.get(target);
  if (!provider) {
    err.write(`pyric deploy: unknown target '${target}'. Must be one of ${targets.join(', ')}.\n`);
    return 1;
  }

  // ── Agent I/O (A6) ──
  const agentIo = AGENT_IO[target];
  const flagJson = parsed.flags.get('json');
  const machineOutput = flagJson !== undefined;
  const jsonPayload = typeof flagJson === 'string' ? flagJson : undefined;

  if (parsed.flags.get('schema') !== undefined) {
    return printToolSchema(target, agentIo, deps, out, err);
  }
  if (machineOutput && !agentIo) {
    err.write(
      `pyric deploy ${target}: --json is not wired for '${target}' yet (hosting only; rules/indexes/functions are follow-ups).\n`,
    );
    return 1;
  }

  // A direct payload bypasses firebase.json entirely — the payload is
  // the whole tool input. Project + credential resolution below still
  // applies (precedence: --json payload fields > everything else).
  let firebaseJson: FirebaseJson = {};
  if (jsonPayload === undefined) {
    try {
      firebaseJson = await fjRead(cwd);
    } catch (e) {
      err.write(`${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  const flagProject = parsed.flags.get('project');
  const explicitProject = typeof flagProject === 'string' ? flagProject : undefined;
  const rc = await rcRead(cwd).catch(() => null);
  // --project accepts a .firebaserc alias or a literal project id —
  // mirror of firebase-tools' resolveAlias (`projects[alias] || alias`,
  // clones/firebase-tools/src/rc.ts:79-81).
  let projectIdHint = explicitProject;
  if (projectIdHint && rc?.projects?.[projectIdHint]) {
    projectIdHint = rc.projects[projectIdHint];
  }
  if (!projectIdHint) {
    projectIdHint = rc?.projects?.default ?? undefined;
  }

  let scope: ProjectScope;
  let grantedScopes: string[] | 'all' = 'all';
  try {
    const resolved = await resolveScopeFn({ projectId: projectIdHint });
    scope = resolved.scope;
    grantedScopes = resolved.grantedScopes ?? 'all';
    // Machine-output mode keeps stdout pure JSON — the banner moves to
    // stderr (same convention as `pyric serve --json`).
    (machineOutput ? err : out).write(
      `pyric deploy: using project '${scope.projectId}' (credentials: ${resolved.source})\n`,
    );
  } catch (e) {
    err.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  if (jsonPayload !== undefined && agentIo) {
    return executeJsonPayload(jsonPayload, agentIo, scope, deps, out, err);
  }

  // Scope-upgrade preflight (logged-in users only; a service account is 'all').
  // A user lacking this target's scope is re-authorized before dispatch (so the
  // login UI never overlaps the deploy board); a non-interactive session fails fast.
  const ensured = await ensureScope({
    requiredScope: provider.requiredScope,
    target,
    scope,
    grantedScopes,
    interactive: !machineOutput && deps.stdout === undefined && process.stdout.isTTY === true,
    env: process.env,
    out,
    err,
    authorizer: deps.loginAuthorizer,
    store: deps.credentialStore,
    client: deps.oauthClient,
  });
  if (!ensured.ok) return ensured.exit;
  scope = ensured.scope;

  // Every target is a registered provider; the dispatcher owns config
  // resolution, the unit loop, exit aggregation, and the live reporter.
  return runProviderDeploy(
    provider,
    {
      firebaseJson,
      firebaseRc: rc,
      flags: parsed.flags,
      projectId: scope.projectId,
      cwd,
      readFile: (p) => readFileFn(p, 'utf-8') as Promise<string>,
      getGitBranch: () => (deps.getGitBranch ?? getGitBranch)(cwd),
    },
    resolveDeployTools(provider, scope, deps),
    // API-enablement preflight, run by the dispatcher AFTER config resolution so
    // a usage error (e.g. missing --source) still exits 1 before any network
    // call. Auto-enables the target's APIs when the caller has permission, else
    // prints console links + fails fast. See design rationale
    () =>
      (deps.ensureApis ?? ensureApisEnabled)({
        scope,
        apis: provider.requiredApis,
        out: machineOutput ? err : out,
        err,
      }),
    out,
    err,
    machineOutput,
    deps.stdout === undefined && process.stdout.isTTY === true,
  );

}

// ─── Agent I/O helpers (A6) ──────────────────────────────────────────

type Sink = { write(s: string): void };

/**
 * Resolve a provider's tools, honoring the per-target test-injection overrides
 * the CLI suite uses (`deps.createXxxDeployTools`). Production passes none, so the
 * provider's own factory runs. This is the legacy DI seam; the providers own
 * their factories, this just lets tests swap a fake in.
 */
function resolveDeployTools(provider: DeployProvider, scope: ProjectScope, deps: DeployDeps): ToolHandler[] {
  const override =
    provider.target === 'functions'
      ? deps.createFunctionsDeployTools
      : provider.target === 'hosting'
        ? deps.createHostingDeployTools
        : provider.target === 'rules' || provider.target === 'indexes'
          ? deps.createFirestoreDeployTools
          : undefined;
  return override ? override({ scope }) : provider.tools(scope);
}

/**
 * Dispatch a registered provider (the strangler-fig path). Resolve config, then
 * run each unit through the provider's handler. A usage error exits 1 BEFORE any
 * network call; a unit's runtime failure continues the remaining units and exits
 * 2 (matching the if-ladder's exit-2 accumulation). The reporter seam
 * (`ctx.report`) is wired with the TTY board in slice 2 — functions emits no
 * steps yet, so behavior here is byte-identical to the old `functions` branch.
 */
async function runProviderDeploy(
  provider: DeployProvider,
  src: ConfigSource,
  tools: ToolHandler[],
  runApiPreflight: () => Promise<EnsureApisResult>,
  out: Sink,
  err: Sink,
  machineOutput: boolean,
  isTTY: boolean,
): Promise<number> {
  const op = provider.operations.find((o) => o.default) ?? provider.operations[0];
  if (!op) {
    err.write(`pyric deploy ${provider.target}: provider exposes no operations.\n`);
    return 2;
  }
  const reporter = createDeployReporter({ out, err, machineOutput, isTTY });
  let exit = 0;
  try {
    const resolved = await provider.resolveConfig(op.name, src);
    if (!resolved.ok) {
      // Usage error (missing/invalid config) — exit 1 before any network call.
      err.write(`pyric deploy ${provider.target}: ${resolved.message}\n`);
      reporter.dispose();
      return 1;
    }
    // Config warnings (e.g. hosting's non-serving keys) print up front. A config
    // READ error (a missing rules file) throws and is caught below as exit 2.
    for (const warning of resolved.warnings ?? []) {
      err.write(`pyric deploy ${provider.target}: warning: ${warning}\n`);
    }
    // Config is valid: ensure the target's Google APIs are enabled before the
    // first mutation. Runs here (after resolveConfig) so a usage error never
    // triggers a network call.
    const apis = await runApiPreflight();
    if (!apis.ok) {
      reporter.dispose();
      return apis.exit ?? 2;
    }
    const handler = tools.find((t) => t.name === op.toolName);
    if (!handler) {
      err.write(`pyric deploy ${provider.target}: ${op.toolName} tool not found.\n`);
      reporter.dispose();
      return 2;
    }
    for (const unit of resolved.units) {
      reporter.report({
        target: provider.target,
        step: 'deploy',
        status: 'start',
        message: `deploying ${provider.target}`,
      });
      const ctx: DeployToolContext = {
        signal: new AbortController().signal,
        // The handler emits target-less step events; stamp the target here.
        report: (e) => reporter.report({ target: provider.target, ...e }),
      };
      const result = await handler.execute(unit, ctx);
      reporter.result(result);
      if (!result.ok) exit = 2;
    }
  } catch (e) {
    reporter.dispose();
    err.write(`pyric deploy ${provider.target}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  reporter.dispose();
  return exit;
}

/**
 * `--schema`: print the tool's `parameters` JSON Schema and exit.
 * Credential-free — handler construction only closes over the scope;
 * `parameters` is static, and the stub scope throws if anything ever
 * tries to execute.
 */
function printToolSchema(
  target: string,
  agentIo: AgentIoEntry | undefined,
  deps: DeployDeps,
  out: Sink,
  err: Sink,
): number {
  if (!agentIo) {
    err.write(
      `pyric deploy ${target}: --schema is not wired for '${target}' yet (hosting only; rules/indexes/functions are follow-ups).\n`,
    );
    return 1;
  }
  const stubScope: ProjectScope = {
    projectId: '(schema-introspection)',
    resolveToken: async () => {
      throw new Error('schema introspection never mints tokens');
    },
  };
  const handler = agentIo.tools(deps, stubScope).find((t) => t.name === agentIo.toolName);
  if (!handler) {
    err.write(`pyric deploy ${target}: ${agentIo.toolName} tool not found.\n`);
    return 2;
  }
  out.write(`${JSON.stringify(handler.parameters, null, 2)}\n`);
  return 0;
}

/**
 * `--json '<payload>'`: validate the payload against the tool's own
 * `parameters` schema and feed it to the handler unchanged. The
 * result ({ok, summary, data}) goes to stdout as JSON; errors —
 * validation or handler failure — go to stderr as JSON. Exit codes
 * keep the CLI contract (0 ok / 1 usage / 2 runtime).
 */
async function executeJsonPayload(
  raw: string,
  agentIo: AgentIoEntry,
  scope: ProjectScope,
  deps: DeployDeps,
  out: Sink,
  err: Sink,
): Promise<number> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    writeJsonError(err, `--json payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    writeJsonError(err, '--json payload must be a JSON object (the tool input)');
    return 1;
  }
  const handler = agentIo.tools(deps, scope).find((t) => t.name === agentIo.toolName);
  if (!handler) {
    writeJsonError(err, `${agentIo.toolName} tool not found`);
    return 2;
  }
  const schema = handler.parameters as SchemaNode;
  const problems = validateAgainstSchema(payload, schema, 'input');
  if (problems.length > 0) {
    writeJsonError(err, `--json payload does not match the ${agentIo.toolName} schema`, problems);
    return 1;
  }
  // Typo guard: JSON Schema permits unknown keys (the handler ignores
  // them), but an agent passing one almost certainly misspelled a real
  // one — diagnostic warning on stderr, not a failure.
  const known = schema.properties ?? {};
  const unknown = Object.keys(payload).filter((k) => !(k in known));
  if (unknown.length > 0) {
    err.write(`pyric deploy: warning: payload keys not in the tool schema: ${unknown.join(', ')}\n`);
  }
  const result = await handler.execute(payload, { signal: new AbortController().signal });
  (result.ok ? out : err).write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 2;
}

function writeJsonError(err: Sink, summary: string, details?: string[]): void {
  err.write(`${JSON.stringify({ ok: false, summary, ...(details ? { details } : {}) })}\n`);
}

/** The JSON-Schema subset the deploy tools' `parameters` actually use. */
interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
}

/**
 * Structural validation against the tool's `parameters` — the subset
 * the deploy schemas use (object/array/string/number/boolean,
 * `required`, nested `properties`, array `items`). Deeper semantic
 * validation stays where it lives today (the handler / the config
 * builder) — single source of truth.
 */
function validateAgainstSchema(value: unknown, schema: SchemaNode, path: string): string[] {
  const errors: string[] = [];
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return [`${path} must be an object`];
      }
      const obj = value as Record<string, unknown>;
      for (const req of schema.required ?? []) {
        if (obj[req] === undefined) errors.push(`${path}.${req} is required`);
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (obj[key] !== undefined) {
          errors.push(...validateAgainstSchema(obj[key], sub, `${path}.${key}`));
        }
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${path} must be an array`];
      if (schema.items) {
        value.forEach((v, i) =>
          errors.push(...validateAgainstSchema(v, schema.items!, `${path}[${i}]`)),
        );
      }
      break;
    }
    case 'string':
      if (typeof value !== 'string') return [`${path} must be a string`];
      break;
    case 'number':
      if (typeof value !== 'number') return [`${path} must be a number`];
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return [`${path} must be a boolean`];
      break;
    default:
      // Untyped node — accept anything (mirrors JSON Schema semantics).
      break;
  }
  return errors;
}

/**
 * `pyric hosting:channel:deploy <channelId> [--expires <ttl>]` —
 * mirror-form alias of `pyric deploy hosting --channel <channelId>`
 * (upstream spelling: `firebase hosting:channel:deploy`,
 * clones/firebase-tools/src/commands/hosting-channel-deploy.ts). It
 * REWRITES the invocation and calls `runDeploy` — one code path, two
 * spellings; the equivalence test in cli.test.ts pins both forms to
 * the identical tool invocation so they can't drift.
 */
export async function runHostingChannelDeploy(
  parsed: ParsedArgs,
  deps: DeployDeps = {},
): Promise<number> {
  const err = deps.stderr ?? process.stderr;
  const channelId = parsed.positional[0];
  if (!channelId) {
    err.write(
      'pyric hosting:channel:deploy: missing <channelId>. Usage: pyric hosting:channel:deploy <channelId> [--expires <30m|12h|7d>]\n',
    );
    return 1;
  }
  const flags = new Map(parsed.flags);
  flags.set('channel', channelId);
  return runDeploy(
    { subcommand: 'deploy', flags, positional: ['hosting', ...parsed.positional.slice(1)] },
    deps,
  );
}

/**
 * Current git branch name, or `null` when git is unavailable / cwd is
 * not a repo. Detached HEAD comes back as the literal `'HEAD'` (the
 * caller rejects it — a preview channel needs a real branch name or
 * an explicit id).
 */
function getGitBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }, (error, stdout) => {
      if (error) return resolve(null);
      const branch = stdout.trim();
      resolve(branch.length > 0 ? branch : null);
    });
  });
}
