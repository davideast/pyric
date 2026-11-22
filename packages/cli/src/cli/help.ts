/**
 * Help and tool discovery for the `pyric` CLI.
 *
 * Kept separate from `index.ts` and loaded lazily on `--help`, bare tool
 * words, and unknown commands so `pyric run` never imports the method registry
 * at startup and `pyric --help` keeps the generated conformance table off its
 * startup module graph.
 */
import { closest } from '../bridge/surface/closest-name.js';
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
import type { ParsedArgs } from './parse-args.js';
import { formatSandboxAmbiguityError } from './sandbox-word-guard.js';
import { argumentKind, FILE_FLAG_SUFFIX } from './surface-method-args.js';

export interface HelpOutput {
  readonly text: string;
  readonly exitCode: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  if (entry.example !== undefined && entry.example.length > 0) {
    lines.push('', 'EXAMPLE', `  ${entry.example}`);
  }
  return `${lines.join('\n')}\n`;
}

function effectSummary(effect: MethodEffect): string {
  if (effect === 'read') return 'read (no state change)';
  if (effect === 'write') return 'write (mutates sandbox state; reversible via checkpoint)';
  if (effect === 'destructive') return 'destructive (requires --confirm true)';
  return 'production (refused by default; pass --allow-production to enable)';
}

function formatJsonSchemaType(schema: unknown): string {
  if (!isRecord(schema)) return 'json';
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => String(v)).join(' | ');
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.anyOf)) {
    const parts = schema.anyOf.map(formatJsonSchemaType);
    return [...new Set(parts)].join(' | ');
  }
  if (schema.type === 'array') {
    if (isRecord(schema.items)) return `${formatJsonSchemaType(schema.items)}[] (JSON)`;
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
  const argEntries = Object.entries(method.args.shape);
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
      const jsonSchema = toJsonSchema(schema);
      const kind = argumentKind(schema);
      let reqLabel = 'required';
      if (schema.isOptional()) reqLabel = 'optional';
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
  pyric snapshot [--out=FILE|DIR]
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
  mcp                        Stdio MCP server (serves all ${toolEntries.length} tools; routes to Node host or in-process).
  snapshot [--out=FILE|DIR]  Promote lived sandbox state to a committable seed file or directory.
  verify [fixture|dir]       Replay a captured session against candidate rules.
  can-i-use <feature>        Check Pyric availability and conformance status for a Firebase feature.
  verify cases [fixture]     Derive Firestore Rules Test API cases from a captured fixture.
  verify staging init        Enroll the empty RTDB instance named in pyric.json verify.staging.
  verify staging restore     Restore staging RTDB rules from .pyric/staging-restore.json.
  firestore rules validate   Validate Firestore rules structure against a file.
  firestore rules resolve    Resolve Firestore 2+modules imports to one ruleset.
  firestore indexes generate Generate firestore.indexes.json from application source.
  storage rules resolve      Resolve Storage 2+modules imports to one ruleset.
  database rules validate    Validate Realtime Database rules expressions.
  database rules generate    Compile a constraints module to database.rules.json.
  database indexes generate  Extract RTDB .indexOn rules from application source.
  serve diagnostics          Read bounded startup and connection reports over HTTP.
  serve sessions             List clients connected to the running bridge.
  serve denials              List RTDB and Firestore rules denials recorded by the running Node host.
  serve repro capture        Write the running Node host repro file.
  serve repro replay <file>  Replay a repro file on a fresh Node host and worker host.
  auth reset                 Follow the application session again on a running bridge.
  <tool> <method>            Call one method on any service tool (${toolNames}).
                             Flags match SDK argument names; --<arg>-file <path> reads from a file.

CORE FLAGS (sandbox)
${formatFlagTable(SANDBOX_CORE_FLAGS).join('\n')}

SERVICE TOOLS (run \`pyric <tool> --help\` or \`pyric <tool> <method> --help\`)
${toolLines.join('\n')}

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
        return { text: formatSandboxAmbiguityError(first), exitCode: 1 };
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
