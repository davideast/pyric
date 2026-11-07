/**
 * The terminal lines a live host prints for the observed calls it accepts:
 * one block for each call production denied, and the AI block for each AI
 * Logic request production rejected (`ai-terminal-blocks.ts`).
 *
 * A denial block names the call, production's code, the client that made it
 * (as the Live tab names it), the uid it ran as, and the local rules file
 * production did not read. Each field is dropped when the call did not carry
 * it, never filled with a placeholder. Every field comes from a page or a
 * process, so each one is flattened with `sanitizeForTerminal`, and an email
 * address in a path is left out.
 *
 * Both throttle like the sandbox's denial relay (`createDenialThrottle`): an
 * app retrying one denied call prints one block per window.
 */
import path from 'node:path';
import { productionVerdict } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import { formatAiRejectionBlock } from './ai-terminal-blocks.js';
import { sanitizeForTerminal } from './ai-terminal-text.js';
import { createDenialThrottle } from './namespace.js';

/** The client an observed call came from, as the host's client list names it. */
export interface LiveCallSource {
  kind: 'browser' | 'service-worker' | 'node';
  /** The page path, a service worker's script or a Node process's entry script. */
  label?: string;
}

/** The local rules files of each service with rules, as the developer names them. */
export interface LiveRulesFiles {
  firestore: readonly string[];
  rtdb: readonly string[];
  storage: readonly string[];
}

/** What a session reports about the rules files it loads (`sandbox-session.ts`). */
export interface RulesFilesSession {
  firestoreRulesFiles(): readonly string[];
  databaseRulesFiles(): readonly string[];
  storageRulesFiles(): readonly string[];
}

const NO_RULES_FILES: LiveRulesFiles = { firestore: [], rtdb: [], storage: [] };

/** The services whose production answer comes from deployed Security Rules. */
const RULES_SERVICES: ReadonlySet<string> = new Set(['firestore', 'rtdb', 'storage']);

/** Each client kind as the Live tab names it. */
const KIND_NAMES: Readonly<Record<LiveCallSource['kind'], string>> = {
  browser: 'browser tab',
  'service-worker': 'service worker',
  node: 'Node process',
};

/** The HTTP status of each production status the live-ai row names (`aiCode` in `@pyric/live`). */
const AI_HTTP_STATUS: Readonly<Record<string, number>> = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  resource_exhausted: 429,
  internal: 500,
  unavailable: 503,
  deadline_exceeded: 504,
};

const HTTP_CODE = /^http_(\d{3})$/;
const EMAIL_ANYWHERE = /[^\s@"'/]+@[^\s@"'/]+\.[^\s@"'/]+/g;

function text(value: string): string {
  return sanitizeForTerminal(value);
}

/** The `from:` value: the client kind, then its label when it has one. */
function fromText(source: LiveCallSource | undefined): string | undefined {
  if (source === undefined) return undefined;
  const kind = KIND_NAMES[source.kind];
  return source.label === undefined || source.label === '' ? kind : `${kind} ${text(source.label)}`;
}

/** The rules files a session loads, relative to the project directory. Firestore's first file is its source. */
export function rulesFilesOf(session: RulesFilesSession, projectDir: string): LiveRulesFiles {
  const named = (files: readonly string[]) => [...new Set(files.map((file) => path.relative(projectDir, path.resolve(projectDir, file))))];
  return {
    firestore: named(session.firestoreRulesFiles().slice(0, 1)),
    rtdb: named(session.databaseRulesFiles()),
    storage: named(session.storageRulesFiles()),
  };
}

function rulesFilesFor(service: string, files: LiveRulesFiles): readonly string[] {
  if (service === 'firestore') return files.firestore;
  if (service === 'rtdb') return files.rtdb;
  return files.storage;
}

/** Whether production's Security Rules denied the call: a client call to a service with rules. */
function isRulesDenial(call: ObservedCall): boolean {
  const isClientCall = call.sdk === undefined && RULES_SERVICES.has(call.service);
  return isClientCall && productionVerdict(call.outcome) === 'denied';
}

/** The block for a call production's Security Rules denied. */
export function formatProductionDenial(call: ObservedCall, source: LiveCallSource | undefined, rulesFiles: LiveRulesFiles): string {
  const target = call.path === undefined ? '' : ` ${text(call.path.replace(EMAIL_ANYWHERE, '[email]'))}`;
  const lines = [`  ⚠ [pyric] production denied: ${call.service} ${text(call.method)}${target}`];
  if (call.outcome.status === 'error') lines.push(`      ${text(call.outcome.code)}`);
  const from = fromText(source);
  if (from !== undefined) lines.push(`      from: ${from}`);
  if (call.account !== undefined) lines.push(`      auth: ${text(call.account.uid)}`);
  const files = rulesFilesFor(call.service, rulesFiles).map(text);
  if (files.length > 0) lines.push(`      production decided this with its deployed rules, not your local ${files.join(', ')}`);
  return lines.join('\n');
}

/** Production's status and HTTP code for an AI call's error code, or null when production never answered. */
function aiProductionStatus(code: string): { status?: string; code: number } | null {
  const http = HTTP_CODE.exec(code);
  if (http !== null) return { code: Number(http[1]) };
  const known = AI_HTTP_STATUS[code];
  return known === undefined ? null : { status: code.toUpperCase(), code: known };
}

/** The block for an AI Logic request production rejected, or null for any other call. */
export function formatObservedAiRejection(call: ObservedCall, source: LiveCallSource | undefined): string | null {
  const isAiError = call.service === 'ai' && call.outcome.status === 'error';
  if (!isAiError) return null;
  const answer = aiProductionStatus((call.outcome as { code: string }).code);
  if (answer === null) return null;
  return formatAiRejectionBlock({ model: call.ai?.model, ...answer }, { from: fromText(source) });
}

/** The block one accepted call prints, with the key its throttle counts it by, or null when it prints none. */
export function liveTerminalBlock(
  call: ObservedCall,
  source: LiveCallSource | undefined,
  rulesFiles: LiveRulesFiles,
): { key: string; block: string } | null {
  const code = call.outcome.status === 'error' ? call.outcome.code : '';
  if (isRulesDenial(call)) {
    const place = call.instance ?? call.bucket ?? '';
    return { key: `live-denial ${call.service} ${place} ${call.method} ${call.path ?? ''} ${code}`, block: formatProductionDenial(call, source, rulesFiles) };
  }
  const ai = formatObservedAiRejection(call, source);
  if (ai === null) return null;
  return { key: `live-ai ${call.ai?.model ?? ''} ${code}`, block: ai };
}

export interface LiveTerminalLines {
  /** One call the host accepted, from the client that sent it. */
  accepted(call: ObservedCall, source: LiveCallSource | undefined): void;
  /** Read the rules file names from the session once it runs. */
  readRulesFiles(read: () => LiveRulesFiles): void;
}

export function createLiveTerminalLines(input: { print(block: string): void; now?: () => number }): LiveTerminalLines {
  const throttle = createDenialThrottle();
  const now = input.now ?? Date.now;
  let readRulesFiles: () => LiveRulesFiles = () => NO_RULES_FILES;
  const currentRulesFiles = (): LiveRulesFiles => {
    try {
      return readRulesFiles();
    } catch {
      return NO_RULES_FILES;
    }
  };
  return {
    accepted(call, source) {
      const printed = liveTerminalBlock(call, source, currentRulesFiles());
      if (printed === null) return;
      if (!throttle.shouldPrint(printed.key, now())) return;
      input.print(printed.block);
    },
    readRulesFiles(read) {
      readRulesFiles = read;
    },
  };
}
