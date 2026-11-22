import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedArgs } from './parse-args.js';

function selectsInProcessSalvage(sourceInput: string): boolean {
  const stat = statSync(sourceInput, { throwIfNoEntry: false });
  if (stat === undefined) return false;
  if (stat.isFile()) return true;
  if (!stat.isDirectory()) return false;
  const hasHostedDb = existsSync(join(sourceInput, 'state.sqlite'));
  const hasInProcessJson = existsSync(join(sourceInput, 'in-process.json'));
  const hasStorageSidecar = existsSync(join(sourceInput, 'storage.json'));
  if (hasHostedDb && hasInProcessJson) {
    throw new Error(
      'Ambiguous recovery source: directory contains both state.sqlite and in-process.json.',
    );
  }
  if (hasHostedDb) return false;
  return hasInProcessJson || hasStorageSidecar;
}

export async function runSalvage(parsed: ParsedArgs): Promise<number> {
  const source = parsed.flags.get('source');
  const output = parsed.flags.get('out');
  const hasPaths = typeof source === 'string' && typeof output === 'string';
  const missingPaths = !hasPaths;
  if (missingPaths) {
    console.error('Usage: pyric sandbox salvage --source <offline-hosted-directory> --out <new-directory>');
    return 1;
  }
  try {
    let report;
    if (selectsInProcessSalvage(source)) {
      const { salvageInProcessState } = await import('../bridge/server/in-process-salvage.js');
      report = await salvageInProcessState(source, output);
    } else {
      const { salvageHostedState } = await import('../serve/hosted/persistence/salvage.js');
      report = await salvageHostedState(source, output);
    }
    console.log(JSON.stringify({ output, ...report }, null, 2));
    console.error('Recovery created a separate copy. Review recovery-report.json before activating it; excluded records may leave incomplete application data.');
    return 0;
  } catch (error) {
    const isError = error instanceof Error;
    let message: string;
    if (isError) message = error.message;
    else message = String(error);
    console.error(message);
    return 1;
  }
}
