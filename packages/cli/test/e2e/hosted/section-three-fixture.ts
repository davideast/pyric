import { readFileSync } from 'node:fs';
import { startSoakServe } from '../soak/harness.js';

export function startSectionThreeFixture(flags: string[]) {
  const files = ['index.html', 'main.js', 'database.rules.json', 'firestore.rules', 'firebase.json', 'concurrent.html', 'concurrent.js'];
  const extraFiles = Object.fromEntries(files.map(name => [
    name, readFileSync(new URL(`../../manual/section-three/${name}`, import.meta.url), 'utf8'),
  ]));
  return startSoakServe({ flags, extraFiles });
}
