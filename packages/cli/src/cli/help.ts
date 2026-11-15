/**
 * Help, tool discovery, and ambiguous-command disambiguation for the `pyric` CLI.
 *
 * Kept separate from `index.ts` and loaded lazily on `--help`, bare tool
 * words, unknown commands, and ambiguous `pyric sandbox <word>` checks so
 * `pyric run` never imports the method registry at startup.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { z } from 'zod';
import { closest, editDistance } from '../bridge/surface/closest-name.js';
import { TOOL_DESCRIPTIONS } from '../bridge/surface/descriptions.generated.js';
import { toJsonSchema } from '../bridge/surface/json-schema.js';
import type { Method, MethodEffect, Tool } from '../bridge/surface/method-types.js';
import { cliVersion } from '../pkg-version.js';
import {
  MULTI_WORD_COMMANDS,
  SANDBOX_CORE_FLAGS,
  TOOL_EXTRA_FIRST_WORDS,
  TOOL_EXTRA_SUBCOMMANDS,
  TOP_LEVEL_COMMANDS,
  type CommandHelpEntry,
} from './help-catalog.js';
import { SANDBOX_METHOD_WORDS, type ParsedArgs } from './parse-args.js';
import { argumentKind, FILE_FLAG_SUFFIX } from './surface-method-args.js';

export interface HelpOutput {
  readonly text: string;
  readonly exitCode: number;
}

const UNSUPPORTED_RUNTIME_WORDS: ReadonlySet<string> = new Set(['bun', 'deno']);

const TOP_LEVEL_PYRIC_WORDS: ReadonlySet<string> = new Set([
  'bridge',
  'run',
  'snapshot',
  'verify',
  'can-i-use',
  'mcp',
  'init',
  'vendor',
  'serve',
  ...Object.keys(TOOL_DESCRIPTIONS).filter((name) => name !== 'sandbox'),
]);

function firstSentence(text: string): string {
  const idx = text.indexOf('. ');
  if (idx === -1) return text;
  return text.slice(0, idx + 1);
}

function formatFlagTable(flags: readonly [flag: string, description: string][]): string[] {
  let width = 18;
  for (const [flag] of flags) {
    if (flag.length + 2 > width) width = flag.length + 2;
  }
  return flags.map(([flag, desc]) => `  ${flag.padEnd(width)}${desc}`);
}

function formatCommandHelp(name: string, entry: CommandHelpEntry): string {
  const lines: string[] = [name, '', entry.summary, '', 'USAGE', `  ${entry.usage}`];
  if (entry.details && entry.details.length > 0) {
    lines.push('', ...entry.details);
  }
  if (entry.flags && entry.flags.length > 0) {
    lines.push('', 'FLAGS', ...formatFlagTable(entry.flags));
  }
  return `${lines.join('\n')}\n`;
}

function effectSummary(effect: MethodEffect): string {
  if (effect === 'read') return 'read (no state change)';
  if (effect === 'write') return 'write (mutates sandbox state; reversible via checkpoint)';
  if (effect === 'destructive') return 'destructive (requires --confirm true)';
  return 'production (refused by default; pass --allow-production to enable)';
}

function isOptionalSchema(schema: z.ZodTypeAny): boolean {
  const typeName = (schema._def as { typeName: string }).typeName;
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}

function formatJsonSchemaType(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) {
    return (schema.enum as unknown[]).map((v) => String(v)).join(' | ');
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.anyOf)) {
    const parts = (schema.anyOf as Record<string, unknown>[]).map(formatJsonSchemaType);
    return [...new Set(parts)].join(' | ');
  }
  if (schema.type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items !== undefined) return `${formatJsonSchemaType(items)}[] (JSON)`;
    return 'array (JSON)';
  }
  if (schema.type === 'object') return 'object (JSON)';
  if (typeof schema.type === 'string') return schema.type;
  return 'json';
}

function formatCliExampleValue(value: unknown): string {
  if (typeof value === 'string') {
    if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  return `'${JSON.stringify(value)}'`;
}

function formatMethodExample(method: Method): string {
  const parts: string[] = ['pyric', method.tool, method.method];
  for (const [key, value] of Object.entries(method.example)) {
    if (value === true) {
      parts.push(`--${key}`);
    } else {
      parts.push(`--${key}`, formatCliExampleValue(value));
    }
  }
  return parts.join(' ');
}

function renderMethodHelp(method: Method): string {
  const shape = method.args.shape;
  const argEntries = Object.entries(shape);
  const lines: string[] = [
    `pyric ${method.tool} ${method.method}`,
    '',
    method.description,
    '',
    'USAGE',
    `  pyric ${method.tool} ${method.method} [--<arg> <value>...] [--json] [--in-process]`,
    '',
    'SIGNATURE',
    `  ${method.signature}`,
    '',
    'EFFECT',
    `  ${effectSummary(method.effect)}`,
    '',
    'ARGUMENTS',
  ];

  if (argEntries.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [name, schema] of argEntries) {
      const zodSchema = schema as z.ZodTypeAny;
      const jsonSchema = toJsonSchema(zodSchema);
      const kind = argumentKind(zodSchema);
      let reqLabel = 'required';
      if (isOptionalSchema(zodSchema)) reqLabel = 'optional';
      const typeLabel = formatJsonSchemaType(jsonSchema);
      let desc = '';
      if (typeof jsonSchema.description === 'string') desc = jsonSchema.description;
      let fileHint = '';
      if (kind === 'string' || kind === 'json') {
        fileHint = ` (or --${name}${FILE_FLAG_SUFFIX} <path>)`;
      }
      lines.push(`  --${name} <${typeLabel}> [${reqLabel}]${fileHint}`);
      if (desc.length > 0) {
        lines.push(`      ${desc}`);
      }
    }
  }

  if (method.tool === 'assurance' && method.method === 'derive') {
    lines.push(
      '',
      'CLI OPTIONS (pyric assurance derive)',
      ...formatFlagTable([
        ['--port N', 'Loopback port of a running Pyric server to clone.'],
        ['--url URL', 'Loopback HTTP(S) URL of a running Pyric server to clone.'],
        ['--root DIR', 'Project directory to scan (default: cwd).'],
        ['--campaign-id ID', 'Explicit campaign id (generated when omitted).'],
        ['--fail-on GATE', 'Exit 1 gate: proven-counterexample, static-proof, heuristic, critical, high, medium, or low.'],
        ['--include-heuristic', 'Include heuristic findings in the default fail gate.'],
        ['--no-static', 'Skip static query, storage contract, index, and coverage passes.'],
        ['--json', 'Print full JSON result on stdout.'],
      ]),
    );
  }

  lines.push(
    '',
    'COMMON FLAGS',
    ...formatFlagTable([
      ['--json', 'Print the full JSON result envelope on stdout.'],
      ['--in-process', 'Run against the local in-process sandbox instead of a running host.'],
      ['--allow-production', 'Allow production-effect methods (refused by default).'],
    ]),
    '',
    'EXAMPLE',
    `  ${formatMethodExample(method)}`,
  );

  return `${lines.join('\n')}\n`;
}

function renderToolHelp(tool: Tool): string {
  const lines: string[] = [`pyric ${tool.name}`, '', tool.intro, '', 'USAGE'];
  if (tool.name === 'sandbox') {
    lines.push(
      '  pyric sandbox [flags] [--] [command...]',
      '  pyric sandbox <method> [--<arg> <value>...] [--json]',
      '  pyric sandbox salvage --source=DIR --out=NEW_DIR',
      '  pyric sandbox seed-from-live --confirm [--replace] | --out=FILE',
      '',
      'LAUNCHER FLAGS',
      ...formatFlagTable(SANDBOX_CORE_FLAGS),
    );
  } else {
    lines.push(`  pyric ${tool.name} <method> [--<arg> <value>...] [--json]`);
  }

  let methodWidth = 18;
  for (const method of tool.methods) {
    if (method.method.length + 2 > methodWidth) methodWidth = method.method.length + 2;
  }

  lines.push('', 'METHODS');
  for (const method of tool.methods) {
    lines.push(`  ${method.method.padEnd(methodWidth)}${method.description}`);
  }

  const extras = TOOL_EXTRA_SUBCOMMANDS[tool.name];
  if (extras && extras.length > 0) {
    lines.push('', 'SUBCOMMANDS', ...formatFlagTable(extras));
  }

  lines.push('', `Run \`pyric ${tool.name} <method> --help\` for arguments and examples.`);
  return `${lines.join('\n')}\n`;
}

function isRegisteredToolName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_DESCRIPTIONS, name);
}

async function loadMethodRegistry() {
  return await import('../bridge/surface/methods/registry.js');
}

function introFromToolDescription(description: string): string {
  const splitAt = description.search(/\s+(?:Read|Write|Destructive|Production) methods:/);
  let intro = description;
  if (splitAt >= 0) {
    intro = description.slice(0, splitAt);
  }
  return firstSentence(intro);
}

export async function renderBareTool(toolName: string): Promise<string | null> {
  if (toolName === 'sandbox') return null;
  if (!isRegisteredToolName(toolName)) return null;
  const { toolByName } = await loadMethodRegistry();
  const tool = toolByName(toolName);
  if (tool === undefined) return null;
  return renderToolHelp(tool);
}

function candidatesForTool(tool: Tool): string[] {
  const extra = TOOL_EXTRA_FIRST_WORDS[tool.name] ?? [];
  return [...tool.methods.map((method) => method.method), ...extra];
}

export async function formatUnknownToolMethod(
  toolName: string,
  positional: readonly string[],
): Promise<string | null> {
  if (!isRegisteredToolName(toolName)) return null;
  const { toolByName } = await loadMethodRegistry();
  const tool = toolByName(toolName);
  if (tool === undefined) return null;
  const attempted = positional[0];
  if (attempted === undefined) return null;

  const extraFirstWords = TOOL_EXTRA_FIRST_WORDS[tool.name] ?? [];
  if (extraFirstWords.includes(attempted)) {
    const groupKey = `${tool.name} ${attempted}`;
    const groupEntry = MULTI_WORD_COMMANDS[groupKey];
    const second = positional[1];
    let header = `pyric ${groupKey}: missing subcommand.\n\n`;
    if (second !== undefined) {
      header = `pyric ${groupKey}: unknown subcommand '${second}'.\n\n`;
    }
    if (groupEntry !== undefined) {
      return `${header}${formatCommandHelp(`pyric ${groupKey}`, groupEntry)}`;
    }
  }

  const suggestion = closest(attempted, candidatesForTool(tool));
  const lines: string[] = [];
  if (suggestion !== null) {
    lines.push(`pyric ${tool.name}: unknown method '${attempted}'. Did you mean \`pyric ${tool.name} ${suggestion}\`?`);
  } else {
    lines.push(`pyric ${tool.name}: unknown method '${attempted}'.`);
  }
  lines.push(`Run \`pyric ${tool.name} --help\` to list available methods.`);
  return `${lines.join('\n')}\n`;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutableOnPath(command: string, cwd: string): boolean {
  const dirs: string[] = [join(cwd, 'node_modules', '.bin')];
  const rawPath = process.env.PATH;
  if (rawPath !== undefined && rawPath.length > 0) {
    for (const entry of rawPath.split(delimiter)) {
      if (entry.length > 0) dirs.push(entry);
    }
  }
  for (const dir of dirs) {
    if (isExecutableFile(join(dir, command))) return true;
  }
  return false;
}

function closeSandboxMethod(word: string): string | null {
  const allSandboxWords = [...SANDBOX_METHOD_WORDS, 'salvage', 'seed-from-live'];
  const lower = word.toLowerCase();
  for (const candidate of allSandboxWords) {
    if (candidate.toLowerCase() === lower) return candidate;
  }
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allSandboxWords) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance <= 2 && distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function formatSandboxAmbiguityError(word: string, reason: 'top-level' | 'near-miss' | 'not-found'): string {
  const allSandboxWords = [...SANDBOX_METHOD_WORDS, 'salvage', 'seed-from-live'];
  if (reason === 'top-level') {
    return [
      `pyric sandbox: '${word}' is a top-level pyric command, not a sandbox method.`,
      `Did you mean \`pyric ${word}\`?`,
      `To run a child executable named '${word}' inside the sandbox, pass \`--\`:`,
      `  pyric sandbox -- ${word}`,
      'Run `pyric sandbox --help` to list sandbox methods and launcher flags.',
      '',
    ].join('\n');
  }
  const suggestion = closest(word, allSandboxWords);
  if (suggestion !== null) {
    return [
      `pyric sandbox: unknown method '${word}'. Did you mean \`pyric sandbox ${suggestion}\`?`,
      'To run a child command inside the sandbox, pass `--`:',
      `  pyric sandbox -- ${word}`,
      'Run `pyric sandbox --help` to list sandbox methods and launcher flags.',
      '',
    ].join('\n');
  }
  return [
    `pyric sandbox: '${word}' is not a sandbox method or an executable on PATH.`,
    'To run a child command inside the sandbox, pass `--`:',
    `  pyric sandbox -- ${word}`,
    'Run `pyric sandbox --help` to list sandbox methods and launcher flags.',
    '',
  ].join('\n');
}

/**
 * Guard `pyric sandbox <word...>` (without `--`) against accidentally launching
 * a sandbox server when `<word>` looks like a mistyped sandbox method, another
 * top-level `pyric` command (such as `snapshot`), or a nonexistent executable.
 */
export function checkAmbiguousSandboxWord(parsed: ParsedArgs, cwd = process.cwd()): string | null {
  if ((parsed.passthrough?.length ?? 0) > 0) return null;
  const first = parsed.positional[0];
  if (first === undefined) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return null;
  if (first.includes('/') || first.includes('\\')) return null;
  if (UNSUPPORTED_RUNTIME_WORDS.has(first)) return null;

  if (TOP_LEVEL_PYRIC_WORDS.has(first)) {
    return formatSandboxAmbiguityError(first, 'top-level');
  }

  const tightMatch = closeSandboxMethod(first);
  if (tightMatch !== null) {
    return formatSandboxAmbiguityError(first, 'near-miss');
  }

  if (!isExecutableOnPath(first, cwd)) {
    return formatSandboxAmbiguityError(first, 'not-found');
  }

  return null;
}

export function renderGlobalUsage(): string {
  const toolEntries = Object.entries(TOOL_DESCRIPTIONS);
  const toolLines = toolEntries.map(([name, description]) => {
    return `  ${name.padEnd(13)} ${introFromToolDescription(description)}`;
  });
  const toolNames = toolEntries.map(([name]) => name).join(', ');

  return `pyric ${cliVersion()}
Firebase for agents. Local Firebase sandbox, rules verification, and MCP tools.

USAGE
  pyric bridge [flags]
  pyric sandbox [flags] [--] [command...]
  pyric run [--sandbox URL] [--wait[=SECONDS]] -- <command...>
  pyric init [dir] [--template=web|node]
  pyric vendor [dir] [--json]
  pyric mcp [--project-dir DIR] [--in-process] [--attach]
  pyric sandbox salvage --source=DIR --out=NEW_DIR
  pyric sandbox seed-from-live --confirm [--replace] | --out=FILE
  pyric snapshot [--out=DIR]
  pyric verify [fixture|dir] [--engine sandbox|rules-test-api|staging|both]
  pyric can-i-use <feature> [--json]
  pyric verify cases [fixture] [--service firestore] [--out FILE]
  pyric verify staging init
  pyric verify staging restore [--force]
  pyric firestore rules validate <path>
  pyric firestore rules resolve <path> [--out <path>]
  pyric firestore indexes generate <path...> [--out <path>]
  pyric storage rules resolve <path> [--out <path>]
  pyric database rules validate <path> [--fail-on <critical|high|medium>]
  pyric database rules generate [--config <path>] [--out <path>] [--fail-on <critical|high|medium>]
  pyric database indexes generate <path...> [--rules <path>] [--out <path>] [--check] [--instance <name>]
  pyric serve diagnostics [--url URL] [--json]
  pyric serve sessions [--json]
  pyric serve denials [--json] [--since <ms|duration>] [--service rtdb|firestore]
  pyric serve repro capture [--out FILE]
  pyric serve repro replay <file> [--plane node|worker] [--json]
  pyric auth reset [--target ID] [--json]
  pyric <tool> <method> [--<arg> <value>...]
  pyric <command|tool> [method] --help
  pyric --help
  pyric --version

COMMANDS
  bridge                     Start an HTTP MCP server without a browser socket.
  sandbox [command...]       Run an app command or host inside the local Firebase sandbox.
  run [--sandbox URL]        Run a command against a running hosted sandbox.
  init [dir]                 Scaffold a Pyric project (web, static, node, or nextjs).
  vendor [dir]               Vendor pyric and @pyric/cli tarballs into an existing project.
  mcp                        Stdio MCP server (serves all 10 tools; routes to Node host or in-process).
  snapshot [--out=DIR]       Promote lived sandbox state to a committable seed directory.
  verify [fixture|dir]       Replay a captured session against candidate rules.
  can-i-use <feature>        Check Pyric availability and conformance status for a Firebase feature.
  <tool> <method>            Call one method on any service tool (${toolNames}).
                             Flags match SDK argument names; --<arg>-file <path> reads from a file.

SERVICE TOOLS (run \`pyric <tool> --help\` or \`pyric <tool> <method> --help\`)
${toolLines.join('\n')}

CORE FLAGS (sandbox)
${formatFlagTable(SANDBOX_CORE_FLAGS).join('\n')}

PROJECT CONFIG (pyric.json)
  command            Default child command. An explicit CLI command overrides it.
  port               Default sandbox port. --port overrides it.
  project            Project label. --project, then PYRIC_PROJECT, override it.
  rules              Firestore rules path, or an object with firestore, database, and storage paths.
  sessionToken       Require a per-boot session capability token on all routes.

CREDENTIALS
  Rules Test API verification resolves existing Google credentials:
    1. FIREBASE_SA_BASE64            base64-encoded service-account JSON (CI)
    2. GOOGLE_APPLICATION_CREDENTIALS  path to a service-account JSON file
    3. ADC                           \`gcloud auth application-default login\` (ambient)
  PYRIC_PROJECT / --project          Firebase project id for Rules Test API verification
`;
}

export async function renderHelp(parsed: ParsedArgs): Promise<HelpOutput> {
  const sub = parsed.subcommand;
  if (sub === null) {
    return { text: renderGlobalUsage(), exitCode: 0 };
  }

  const [first, second] = parsed.positional;

  if (first !== undefined && second !== undefined) {
    const threeKey = `${sub} ${first} ${second}`;
    const threeEntry = MULTI_WORD_COMMANDS[threeKey];
    if (threeEntry !== undefined) {
      return { text: formatCommandHelp(`pyric ${threeKey}`, threeEntry), exitCode: 0 };
    }
  }
  if (first !== undefined) {
    const twoKey = `${sub} ${first}`;
    const twoEntry = MULTI_WORD_COMMANDS[twoKey];
    if (twoEntry !== undefined) {
      return { text: formatCommandHelp(`pyric ${twoKey}`, twoEntry), exitCode: 0 };
    }
  }

  if (isRegisteredToolName(sub)) {
    const { toolByName, methodByName } = await loadMethodRegistry();
    const tool = toolByName(sub);
    if (tool !== undefined) {
      if (first === undefined) {
        return { text: renderToolHelp(tool), exitCode: 0 };
      }
      const method = methodByName(tool, first);
      if (method !== undefined) {
        return { text: renderMethodHelp(method), exitCode: 0 };
      }
      if (tool.name === 'sandbox') {
        let reason: 'top-level' | 'not-found' = 'not-found';
        if (TOP_LEVEL_PYRIC_WORDS.has(first)) reason = 'top-level';
        return { text: formatSandboxAmbiguityError(first, reason), exitCode: 1 };
      }
      const unknownText = await formatUnknownToolMethod(tool.name, parsed.positional);
      return { text: unknownText ?? renderGlobalUsage(), exitCode: 1 };
    }
  }

  if (sub === 'serve') {
    const serveHelp = [
      'pyric serve <subcommand>',
      '',
      'Inspection and repro commands for a running Pyric host.',
      '',
      'SUBCOMMANDS',
      '  pyric serve diagnostics [--url URL] [--json]',
      '  pyric serve sessions [--json]',
      '  pyric serve denials [--json] [--since <ms|duration>] [--service rtdb|firestore]',
      '  pyric serve repro capture [--out FILE] [--force]',
      '  pyric serve repro replay <file> [--plane node|worker] [--json]',
      '',
    ].join('\n');
    return { text: serveHelp, exitCode: 0 };
  }

  const topEntry = TOP_LEVEL_COMMANDS[sub];
  if (topEntry !== undefined) {
    return { text: formatCommandHelp(`pyric ${sub}`, topEntry), exitCode: 0 };
  }

  return { text: renderGlobalUsage(), exitCode: 0 };
}
