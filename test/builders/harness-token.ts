/**
 * Where the harness's token comes from: `--token-file <path>`, or
 * `CLAUDE_CODE_OAUTH_TOKEN` in the harness's own environment when no file is
 * named. Only the harness process reads it, outside every sandbox, and hands
 * it to the model forwarder and the token scan. Nothing here says the
 * token's value: a refusal names the file and the rule it broke, never what
 * the file holds.
 *
 * A token file is refused unless it is a regular file (not a link), owned by
 * the current user, with no group or other access (0600 or stricter), and
 * holds exactly one non-empty line.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { OAUTH_TOKEN_ENV } from './builder-command.ts';

export type TokenRead = { ok: true; token: string } | { ok: false; problem: string };

export interface HarnessToken {
  /** The token, or undefined when neither source holds one. */
  token: string | undefined;
  /** What keeps the token from being read; each names a file or a variable, never a value. */
  problems: string[];
  /** What the harness tells its owner about the token's source; never a value. */
  notices: string[];
}

/** Opened without following a link, and without waiting on a FIFO. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Bits that grant the file's group or other users any access. */
const GROUP_OR_OTHER = 0o077;

const octal = (mode: number) => `0${(mode & 0o777).toString(8)}`;

function openProblem(path: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return `the token file ${path} does not exist`;
  if (code === 'ELOOP') return `the token file ${path} is a symbolic link: name the file itself`;
  if (code === 'EACCES') return `the token file ${path} can't be read by the current user`;
  return `the token file ${path} can't be opened (${code ?? 'unknown error'})`;
}

/** The token from the file's text, or undefined when it is not exactly one non-empty line. */
export function tokenFromText(text: string): string | undefined {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const isOneLine = !body.includes('\n') && !body.includes('\r');
  const token = body.trim();
  return isOneLine && token !== '' ? token : undefined;
}

function statProblem(path: string, fd: number, uid: number): string | undefined {
  const stat = fstatSync(fd);
  if (!stat.isFile()) return `the token file ${path} is not a regular file`;
  if (stat.uid !== uid) return `the token file ${path} is not owned by the current user`;
  const isPrivate = (stat.mode & GROUP_OR_OTHER) === 0;
  if (!isPrivate) return `the token file ${path} allows group or other access (mode ${octal(stat.mode)}): run \`chmod 600 ${path}\``;
  return undefined;
}

/** Reads a token file, or says which rule it breaks. `uid` is the current user's by default. */
export function readTokenFile(path: string, uid: number = process.getuid?.() ?? -1): TokenRead {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (error) {
    return { ok: false, problem: openProblem(path, error) };
  }
  try {
    const problem = statProblem(path, fd, uid);
    if (problem !== undefined) return { ok: false, problem };
    const token = tokenFromText(readFileSync(fd, 'utf8'));
    if (token === undefined) return { ok: false, problem: `the token file ${path} must hold exactly one non-empty line` };
    return { ok: true, token };
  } finally {
    closeSync(fd);
  }
}

function envToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env[OAUTH_TOKEN_ENV];
  const isSet = token !== undefined && token !== '';
  return isSet ? token : undefined;
}

/**
 * The harness's token: from `tokenFile` when one is named, which wins over
 * the environment, and from `CLAUDE_CODE_OAUTH_TOKEN` otherwise.
 */
export function harnessToken(tokenFile: string | undefined, env: NodeJS.ProcessEnv = process.env): HarnessToken {
  const fromEnv = envToken(env);
  if (tokenFile === undefined) return { token: fromEnv, problems: [], notices: [] };
  const notices = fromEnv === undefined ? [] : [`--token-file wins over ${OAUTH_TOKEN_ENV}, which is also set; the harness uses the file's token`];
  const read = readTokenFile(tokenFile);
  return read.ok ? { token: read.token, problems: [], notices } : { token: undefined, problems: [read.problem], notices };
}

/** What a model builder needs when it has no token. */
export const NO_TOKEN_PROBLEM = `no token for the model forwarder: pass --token-file <path> (see test/builders/README.md) or set ${OAUTH_TOKEN_ENV}`;
