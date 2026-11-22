import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { formatPyricCommand, type PyricCommandPrefixOptions } from '../cli/command-hint.js';
import { summarizeCaptureJson } from './capture-store.js';

export type VerifyHintService = 'firestore' | 'database' | 'storage';

export interface VerifyHintOptions {
  readonly live?: boolean;
  readonly capturePath?: string | null;
  readonly hasCapturedSession?: () => boolean;
  readonly commandPrefixOptions?: PyricCommandPrefixOptions;
}

const GENERATED_RULES_STAMP_FILE = 'generated-rules-stamp.json';
const GENERATED_RULES_STAMP_TTL_MS = 15_000;

interface GeneratedRulesStamp {
  readonly path: string;
  readonly contentHash: string;
  readonly at: number;
}

function canonicalPath(filePath: string): string {
  const resolved = resolve(filePath);
  try {
    return realpathSync(resolved);
  } catch (error) {
    void error;
  }
  try {
    return join(realpathSync(dirname(resolved)), basename(resolved));
  } catch (error) {
    void error;
    return resolved;
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Record inside an existing `.pyric/` directory that a CLI generator just wrote
 * `rulesFilePath` so a running host watcher does not spend the user's first-edit
 * `pyric verify` hint on the generated write.
 */
export function recordGeneratedRulesWrite(
  projectDir: string,
  rulesFilePath: string,
  content: string,
): void {
  const pyricDir = join(projectDir, '.pyric');
  if (!existsSync(pyricDir)) {
    return;
  }
  const stamp: GeneratedRulesStamp = {
    path: canonicalPath(rulesFilePath),
    contentHash: hashContent(content),
    at: Date.now(),
  };
  try {
    writeFileSync(join(pyricDir, GENERATED_RULES_STAMP_FILE), `${JSON.stringify(stamp)}\n`, 'utf8');
  } catch (error) {
    void error;
  }
}

function consumesGeneratedRulesStamp(
  capturePath: string | null | undefined,
  changedFile: string | undefined,
): boolean {
  if (!capturePath || !changedFile) {
    return false;
  }
  const stampPath = join(dirname(capturePath), GENERATED_RULES_STAMP_FILE);
  if (!existsSync(stampPath)) {
    return false;
  }
  try {
    const raw = JSON.parse(readFileSync(stampPath, 'utf8')) as Partial<GeneratedRulesStamp>;
    const hasFields =
      typeof raw.path === 'string' &&
      typeof raw.contentHash === 'string' &&
      typeof raw.at === 'number';
    if (!hasFields) {
      rmSync(stampPath, { force: true });
      return false;
    }
    const expired = Date.now() - raw.at > GENERATED_RULES_STAMP_TTL_MS;
    if (expired) {
      rmSync(stampPath, { force: true });
      return false;
    }
    if (canonicalPath(changedFile) !== raw.path) {
      return false;
    }
    const currentContent = readFileSync(changedFile, 'utf8');
    if (hashContent(currentContent) === raw.contentHash) {
      return true;
    }
    rmSync(stampPath, { force: true });
    return false;
  } catch (error) {
    void error;
    return false;
  }
}

function captureFileHasEvents(capturePath: string | null | undefined): boolean {
  if (!capturePath) {
    return false;
  }
  try {
    const raw = readFileSync(capturePath, 'utf8');
    const summary = summarizeCaptureJson(raw);
    return summary !== null && summary.eventCount > 0;
  } catch (error) {
    void error;
    return false;
  }
}

/**
 * Suffix for a rules reload line. On a sandbox host, prints the `verify` hint
 * only when a captured session exists, once per service, skipping tool-generated
 * rules writes. On a live host, notes on every reload that production keeps its
 * deployed rules.
 */
export function createVerifyHint(
  options: VerifyHintOptions = {},
): (service?: VerifyHintService, changedFile?: string) => string {
  if (options.live === true) {
    return () => ' for the sandbox. Production keeps its deployed rules.';
  }
  const checkCaptured =
    options.hasCapturedSession ?? (() => captureFileHasEvents(options.capturePath));
  const printedServices = new Set<VerifyHintService>();
  return (service: VerifyHintService = 'firestore', changedFile?: string) => {
    if (printedServices.has(service)) {
      return '';
    }
    if (consumesGeneratedRulesStamp(options.capturePath, changedFile)) {
      return '';
    }
    if (!checkCaptured()) {
      return '';
    }
    printedServices.add(service);
    const cmd = formatPyricCommand('verify', options.commandPrefixOptions);
    return ` (run \`${cmd}\` to replay the captured session against these rules)`;
  };
}
