import { rolls } from './rolls.mjs';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function pointsFunction(packageDirectory) {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json')));
  const entry = manifest.exports['./experimental/policy'].import;
  const { compileFunction } = await import(pathToFileURL(resolve(packageDirectory, entry)));
  return compileFunction(readFileSync(new URL('yacht-points.rules', import.meta.url), 'utf8'));
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const score = await pointsFunction(process.argv[2]);
  const categories = JSON.parse(process.argv[3]);
  const values = [];
  for (const dice of rolls()) for (const category of categories) {
    const points = Number(score(category, dice));
    if (!Number.isInteger(points) || points < 0 || points > 255) throw Error('Invalid points for ' + category + ': ' + points);
    values.push(points);
  }
  console.log(JSON.stringify({ module: score.firestoreModule(), scores: Buffer.from(values).toString('base64') }));
}
