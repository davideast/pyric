import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function* filesBelow(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesBelow(path);
    else yield path;
  }
}

export function findBrokenPublishedSourceMaps(packageRoot) {
  const dist = join(packageRoot, 'dist');
  if (!existsSync(dist)) return [];

  const broken = [];
  for (const mapPath of filesBelow(dist)) {
    if (!mapPath.endsWith('.map')) continue;
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    for (const [index, source] of (map.sources ?? []).entries()) {
      if (/^(?:data:|https?:|webpack:)/.test(source)) continue;
      if (map.sourcesContent?.[index] != null) continue;
      const sourcePath = resolve(dirname(mapPath), map.sourceRoot ?? '', source);
      if (!existsSync(sourcePath)) {
        broken.push({ mapPath, source, sourcePath });
      }
    }
  }
  return broken;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageRoot = process.argv[2];
  if (!packageRoot) throw new Error('usage: node verify-published-sourcemaps.mjs <package-root>');
  const broken = findBrokenPublishedSourceMaps(packageRoot);
  if (broken.length > 0) {
    console.error(`published source maps reference ${broken.length} missing source file(s)`);
    for (const issue of broken.slice(0, 10)) {
      console.error(`  ${issue.mapPath}: ${issue.source}`);
    }
    if (broken.length > 10) console.error(`  …and ${broken.length - 10} more`);
    process.exit(1);
  }
}
