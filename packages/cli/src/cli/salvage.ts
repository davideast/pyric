import type { ParsedArgs } from './parse-args.js';
import { salvageHostedState } from '../serve/hosted/persistence/salvage.js';

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
    const report = await salvageHostedState(source, output);
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
