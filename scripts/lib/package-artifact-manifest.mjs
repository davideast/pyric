import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

function readTarEntries(tarballPath) {
  const archive = gunzipSync(readFileSync(tarballPath));
  const entries = [];
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const contentsOffset = offset + 512;
    entries.push({ path, contents: archive.subarray(contentsOffset, contentsOffset + size) });
    offset = contentsOffset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarEntry(tarballPath, entryPath) {
  const entry = readTarEntries(tarballPath).find(({ path }) => path === entryPath);
  if (entry) return entry.contents.toString('utf8');
  throw new Error(`${entryPath} not found in ${tarballPath}`);
}

export function assertPackageArtifactHygiene(tarballPath) {
  const forbidden = readTarEntries(tarballPath)
    .map(({ path }) => path)
    .filter((path) =>
      path
        .split('/')
        .some(
          (segment) =>
            segment.startsWith('._') ||
            segment === '.DS_Store' ||
            segment === '__MACOSX' ||
            segment === 'README.md.orig',
        ),
    );

  if (forbidden.length > 0) {
    throw new Error(
      `${tarballPath} contains forbidden package files:\n${forbidden
        .map((path) => `  - ${path}`)
        .join('\n')}`,
    );
  }
}

/**
 * Build the release manifest from the package manifests inside the tarballs.
 * Source manifests are used only to locate each artifact.
 */
export function createPackageArtifactManifest({
  root,
  outDir,
  packageDirs,
  generatedAt = new Date().toISOString(),
}) {
  return {
    generated: generatedAt,
    packages: packageDirs.map((sourceDir) => {
      const sourceManifest = JSON.parse(
        readFileSync(join(root, sourceDir, 'package.json'), 'utf8'),
      );
      const flatName = sourceManifest.name.replace(/^@/, '').replace(/\//g, '-');
      const file = `${flatName}-${sourceManifest.version}.tgz`;
      const fullPath = join(outDir, file);
      assertPackageArtifactHygiene(fullPath);
      const packedManifest = JSON.parse(readTarEntry(fullPath, 'package/package.json'));

      return {
        name: packedManifest.name,
        version: packedManifest.version,
        tarball: `dist/packages/${file}`,
        bytes: statSync(fullPath).size,
        sourceDir,
        subpaths: packedManifest.exports ? Object.keys(packedManifest.exports).sort() : [],
        bin: packedManifest.bin ? Object.keys(packedManifest.bin) : [],
      };
    }),
  };
}

export function writePackageArtifactManifest(options) {
  const manifest = createPackageArtifactManifest(options);
  writeFileSync(join(options.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , root, outDir, ...packageDirs] = process.argv;
  if (!root || !outDir || packageDirs.length === 0) {
    throw new Error(
      'usage: node package-artifact-manifest.mjs <root> <out-dir> <package-dir>...',
    );
  }
  const manifest = writePackageArtifactManifest({ root, outDir, packageDirs });
  console.log(
    `    → dist/packages/manifest.json (${manifest.packages.length} packages)`,
  );
}
