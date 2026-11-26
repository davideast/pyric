import { readFile, writeFile } from 'node:fs/promises';
import { compileBoundedModule } from '@pyric/rules/experimental/policy';

for (const name of ['chess', 'chess-match']) {
  const source = await readFile(new URL('./' + name + '.policy', import.meta.url), 'utf8');
  const { moduleSource } = compileBoundedModule(source);
  await writeFile(new URL('./' + name + '.mjs', import.meta.url), moduleSource);
}
