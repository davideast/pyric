#!/usr/bin/env bun
/**
 * Generate mechanical API reference from the declarations named by each
 * package's public export map.
 *
 * `--write` updates committed `*.generated.md` files. `--check` (the default)
 * regenerates in memory and fails on drift. Run the repository build first so
 * every manifest `types` target exists.
 *
 * Hand-written reference pages continue to carry behavioural guidance. These
 * generated files are the declaration receipt: they prove that reference
 * plumbing follows the public package contract instead of a second list of
 * source paths.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
const execFileAsync = promisify(execFile);
const DEFAULT_RENDER_CONCURRENCY = 4;

export const GENERATED_HEADER =
  '<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->';

type WorkspacePackage = 'pyric' | 'pyric-admin' | 'cli';

export interface ApiDescriptor {
  pkg: WorkspacePackage;
  subpath: string;
}

/**
 * Consumer-facing exports with API-reference value. Internal library seams are
 * intentionally absent. Every final @pyric/cli subpath is included because its
 * export map is the package contract this epic settles.
 */
export const API_DESCRIPTORS: ApiDescriptor[] = [
  { pkg: 'pyric', subpath: 'app' },
  { pkg: 'pyric', subpath: 'firestore' },
  { pkg: 'pyric', subpath: 'auth' },
  { pkg: 'pyric', subpath: 'database' },
  { pkg: 'pyric', subpath: 'storage' },
  { pkg: 'pyric', subpath: 'rules' },
  { pkg: 'pyric', subpath: 'sandbox' },
  { pkg: 'pyric', subpath: 'firestore-values' },
  { pkg: 'pyric-admin', subpath: 'app' },
  { pkg: 'pyric-admin', subpath: 'firestore' },
  { pkg: 'pyric-admin', subpath: 'auth' },
  { pkg: 'pyric-admin', subpath: 'database' },
  { pkg: 'pyric-admin', subpath: 'storage' },
  { pkg: 'cli', subpath: 'credentials/node' },
  { pkg: 'cli', subpath: 'verify' },
  { pkg: 'cli', subpath: 'assurance' },
  { pkg: 'cli', subpath: 'assurance/browser' },
  { pkg: 'cli', subpath: 'bridge' },
  { pkg: 'cli', subpath: 'bridge/client' },
  { pkg: 'cli', subpath: 'discover' },
  { pkg: 'cli', subpath: 'vite' },
  { pkg: 'cli', subpath: 'serve/worker' },
  { pkg: 'cli', subpath: 'remote' },
  { pkg: 'cli', subpath: 'register' },
];

interface PackageManifest {
  name: string;
  exports: Record<string, { types?: string }>;
  pyricUnreleasedExports?: string[];
}

function packageManifest(pkg: WorkspacePackage): PackageManifest {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', pkg, 'package.json'), 'utf8'),
  ) as PackageManifest;
}

/** Descriptors minus exports explicitly stripped from published packages. */
export function releasedDescriptors(
  descriptors: ApiDescriptor[] = API_DESCRIPTORS,
): ApiDescriptor[] {
  const manifests = new Map<WorkspacePackage, PackageManifest>();
  return descriptors.filter((descriptor) => {
    const manifest = manifests.get(descriptor.pkg) ?? packageManifest(descriptor.pkg);
    manifests.set(descriptor.pkg, manifest);
    const key = `./${descriptor.subpath}`;
    return !(manifest.pyricUnreleasedExports ?? []).includes(key);
  });
}

/** Resolve declarations from the manifest itself; do not duplicate dist paths. */
export function entryDtsPath(descriptor: ApiDescriptor): string {
  const manifest = packageManifest(descriptor.pkg);
  const key = `./${descriptor.subpath}`;
  const target = manifest.exports[key]?.types;
  if (!target) {
    throw new Error(`missing public types target: ${manifest.name} export ${key}`);
  }
  return join(REPO_ROOT, 'packages', descriptor.pkg, target);
}

export function outputPath(descriptor: ApiDescriptor): string {
  if (descriptor.pkg === 'cli') {
    const slug = descriptor.subpath.replaceAll('/', '-');
    return join(REPO_ROOT, 'packages', 'cli', 'docs', 'reference', `${slug}.api.generated.md`);
  }
  return join(
    REPO_ROOT,
    'packages',
    descriptor.pkg,
    'docs',
    descriptor.subpath,
    'reference',
    'api.generated.md',
  );
}

function publicName(descriptor: ApiDescriptor): string {
  const packageName = packageManifest(descriptor.pkg).name;
  return `${packageName}/${descriptor.subpath}`;
}

export async function renderApiMarkdown(descriptor: ApiDescriptor): Promise<string> {
  const entry = entryDtsPath(descriptor);
  if (!existsSync(entry)) {
    throw new Error(`missing declaration entry: ${entry}\n  Build first: bun run build`);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'pyric-api-docs-'));
  try {
    const options = {
      entryPoints: [entry],
      plugin: ['typedoc-plugin-markdown'],
      out: tmp,
      name: publicName(descriptor),
      readme: 'none',
      githubPages: false,
      skipErrorChecking: true,
      excludeInternal: true,
      excludePrivate: true,
      disableSources: true,
      validation: {
        // A subpath entry deliberately excludes private and sibling symbols.
        // Links to those symbols are useful in source but cannot resolve in a
        // standalone public-subpath receipt.
        notExported: false,
        invalidLink: false,
      },
      outputFileStrategy: 'modules',
      hideBreadcrumbs: true,
      hidePageHeader: true,
    };
    const optionsPath = join(tmp, 'typedoc.json');
    writeFileSync(optionsPath, JSON.stringify(options, null, 2));
    await execFileAsync('bunx', ['typedoc', '--options', optionsPath], {
      cwd: REPO_ROOT,
    });
    const body = readFileSync(join(tmp, 'README.md'), 'utf8').replace(/\s+$/, '');
    return `${GENERATED_HEADER}\n\n${body}\n`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function renderDescriptors(
  descriptors: ApiDescriptor[],
  concurrency = DEFAULT_RENDER_CONCURRENCY,
): Promise<string[]> {
  const rendered = new Array<string>(descriptors.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), descriptors.length) },
    async () => {
      while (next < descriptors.length) {
        const index = next++;
        rendered[index] = await renderApiMarkdown(descriptors[index]);
      }
    },
  );
  await Promise.all(workers);
  return rendered;
}

function parseArgs(argv: string[]): { write: boolean; check: boolean; only: Set<string> | null } {
  const write = argv.includes('--write');
  const check = argv.includes('--check') || !write;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      only.push(argv[i + 1]);
    }
  }
  return { write, check, only: only.length ? new Set(only) : null };
}

function selected(only: Set<string> | null): ApiDescriptor[] {
  const released = releasedDescriptors();
  if (!only) return released;
  return released.filter((descriptor) => {
    const packageName = packageManifest(descriptor.pkg).name;
    return only.has(`${packageName}/${descriptor.subpath}`);
  });
}

if (import.meta.main) {
  const { write, check, only } = parseArgs(process.argv.slice(2));
  const descriptors = selected(only);
  if (descriptors.length === 0) {
    console.error('No matching released descriptors. Use --only <package/subpath>.');
    process.exit(1);
  }

  const rendered = await renderDescriptors(descriptors);

  if (write) {
    for (const [index, descriptor] of descriptors.entries()) {
      const out = outputPath(descriptor);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, rendered[index]);
      console.log(`Generated ${out.replace(`${REPO_ROOT}/`, '')}`);
    }
  }

  if (check) {
    const problems: string[] = [];
    for (const [index, descriptor] of descriptors.entries()) {
      const out = outputPath(descriptor);
      const rel = out.replace(`${REPO_ROOT}/`, '');
      const generated = rendered[index];
      if (!existsSync(out)) problems.push(`${rel}: missing`);
      else if (readFileSync(out, 'utf8') !== generated) problems.push(`${rel}: drifted`);
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`- ${problem}`);
      console.error('Run bun run docs:api:generate after bun run build.');
      process.exit(1);
    }
    console.log(`API reference matches public declarations (${descriptors.length} checked).`);
  }
}
