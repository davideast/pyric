/**
 * The second guard on the harness's token, after the forwarder keeps it out
 * of the sandbox: before `round` keeps anything of a run, it looks for the
 * token's value in every file it would keep. A text file it copies has the
 * value replaced; the app, packed as a tarball, is withheld when any file of
 * it holds the value. What it reports names files, never the value.
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REDACTED = '[redacted: the harness token]';

/** Directories a scan does not enter: installed packages, which the harness does not keep. */
const SKIPPED = new Set(['node_modules']);

/** Paths a scan or a copy leaves alone, such as the planted ones (`planted-links.ts`). */
export type Skipped = ReadonlySet<string>;

const NONE: Skipped = new Set();

/** The files under `path` (a file or a directory) that hold `secret`, but not `skip`. Symbolic links are not followed. */
export function filesContaining(path: string, secret: string, skip: Skipped = NONE): string[] {
  if (skip.has(path)) return [];
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink()) return [];
  if (stat.isFile()) return readFileSync(path).includes(secret) ? [path] : [];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).filter((name) => !SKIPPED.has(name)).flatMap((name) => filesContaining(join(path, name), secret, skip));
}

/** One secret, several (the harness can hold a token file's and the environment's), or none. */
export type Secrets = string | readonly string[] | undefined;

const secretList = (secrets: Secrets): readonly string[] => (secrets === undefined ? [] : typeof secrets === 'string' ? [secrets] : secrets);

function redactedOne(content: Buffer, secret: string): Buffer {
  if (!content.includes(secret)) return content;
  return Buffer.from(content.toString('latin1').split(Buffer.from(secret).toString('latin1')).join(REDACTED), 'latin1');
}

const redacted = (content: Buffer, secrets: readonly string[]) => secrets.reduce(redactedOne, content);

/** `text` with every occurrence of each secret replaced; `text` itself when there is none. */
export function redactedText(text: string, secret: Secrets): string {
  return secretList(secret).reduce((current, value) => current.split(value).join(REDACTED), text);
}

/** Copies `from` (a file or a directory) to `to`, but not `skip`, with every occurrence of each secret replaced. */
export function copyRedacted(from: string, to: string, secret: Secrets, skip: Skipped = NONE): void {
  if (skip.has(from)) return;
  const stat = lstatSync(from, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyRedacted(join(from, name), join(to, name), secret, skip);
    return;
  }
  if (!stat.isFile()) return;
  const secrets = secretList(secret);
  if (secrets.length === 0) copyFileSync(from, to);
  else writeFileSync(to, redacted(readFileSync(from), secrets));
}
