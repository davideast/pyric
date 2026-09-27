// Watches missing rules files on the real file system and prints what each
// scenario reported, as JSON. Run in its own process by rules-files-watch.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchRulesFiles } from '../../../src/serve/rules-files-watch.js';

interface Outcome {
  changed: string[];
  errors: string[];
  file: string;
}

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; waited < 3000 && !condition(); waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function scenario(nested: boolean): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-rules-files-watch-'));
  const file = nested ? join(dir, 'games', 'pool', 'pool.rules') : join(dir, 'b.rules');
  const changed: string[] = [];
  const errors: string[] = [];
  const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => errors.push(String(e)));
  if (nested) {
    mkdirSync(join(dir, 'games', 'pool'), { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  writeFileSync(file, 'rules_version = \'2+modules\';');
  await until(() => changed.length > 0);
  watch.close();
  return { changed, errors, file };
}

interface DeletionOutcome extends Outcome {
  afterDelete: number;
  afterRecreate: number;
}

// Delete a watched file that exists, then create it again.
async function deletion(): Promise<DeletionOutcome> {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-rules-files-watch-'));
  const file = join(dir, 'database.rules.json');
  writeFileSync(file, '{ "rules": {} }');
  const changed: string[] = [];
  const errors: string[] = [];
  const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => errors.push(String(e)));
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(file);
  await until(() => changed.length > 0);
  const afterDelete = changed.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(file, '{ "rules": {} }');
  await until(() => changed.length > afterDelete);
  const afterRecreate = changed.length;
  watch.close();
  return { changed, errors, file, afterDelete, afterRecreate };
}

const outcomes = {
  missingFile: await scenario(false),
  missingDirectory: await scenario(true),
  deletedFile: await deletion(),
};
console.log(JSON.stringify(outcomes));
process.exit(0);
