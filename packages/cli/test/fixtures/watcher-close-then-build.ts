/**
 * Closes a real watcher in the same tick that opened it, then runs one
 * `Bun.build`, and prints whether the build finished. It prints `stalled` under
 * Bun 1.3.11 unless `keep-real-watchers-open.ts` is loaded first. The stall
 * lasts for the life of the process, so this runs in a child process.
 */
import { watch, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STALL_MS = 10_000;

const directory = mkdtempSync(join(tmpdir(), 'pyric-watcher-close-'));
const entry = join(directory, 'entry.ts');
writeFileSync(entry, 'export const answer: number = 42;\n');

watch(directory, () => {}).close();

const outcome = await Promise.race([
  Bun.build({ entrypoints: [entry], outdir: directory, target: 'node' }).then(() => 'built'),
  new Promise<string>((resolve) => setTimeout(resolve, STALL_MS, 'stalled')),
]);
console.log(outcome);
process.exit(0);
