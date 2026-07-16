#!/usr/bin/env bun
/**
 * Generate the site API reference from the declarations published by each
 * package export map.
 *
 * TypeDoc owns declaration extraction and signature rendering. This script
 * owns the site contract around it: which published packages are documented,
 * which exported implementation seams are excluded, stable route names, and
 * the generated front matter consumed by the API-reference template.
 *
 * `--write` updates docs/api-reference/generated/*.md. `--check` (the
 * default) regenerates in memory and fails on drift. Build the packages first
 * so every manifest `types` target exists.
 */
import { execFileSync } from 'node:child_process';
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
import { canIUseImport } from '@pyric/cli/conformance';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
/**
 * The generated API reference is written into the site's gitignored generated
 * content directory, flat, one file per route slug (plus the api-reference
 * index). The site build (`bun run generate` in packages/site-docs) invokes
 * this generator right before `astro build`; nothing here is committed.
 */
export const OUTPUT_ROOT = join(
  REPO_ROOT,
  'packages',
  'site-docs',
  'src',
  'content',
  '_generated',
);
/** Group label + base order the API-reference pages carry as front matter. */
export const API_REFERENCE_GROUP = 'API reference';

export const GENERATED_HEADER =
  '<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->';

/** The packages packed and published by scripts/publish-alpha.sh. */
export const PUBLISHED_PACKAGE_DIRS = [
  'pyric',
  'pyric-admin',
  'create-pyric',
  'cli',
  'ui',
] as const;

export type PublishedPackageDir = (typeof PUBLISHED_PACKAGE_DIRS)[number];

/**
 * Published adapter seams used by Pyric itself, not developer-facing APIs.
 * `/internal` paths are excluded mechanically below. These three historical
 * names cannot express that intent in their path, so each needs a disposition.
 */
export const NON_USER_FACING_EXPORTS: ReadonlyMap<string, string> = new Map([
  [
    'pyric:./app/register',
    'Node loader adapter used by @pyric/cli/register, not a developer API.',
  ],
  [
    'pyric:./sandbox/admin-compat',
    'Cross-package admin compatibility seam, not a developer API.',
  ],
  [
    'pyric:./sandbox/admin-firestore',
    'Cross-package admin Firestore seam, not a developer API.',
  ],
]);

type ExportTarget = string | { [condition: string]: ExportTarget | undefined };

interface PackageManifest {
  name: string;
  private?: boolean;
  exports?: Record<string, ExportTarget>;
  pyricUnreleasedExports?: string[];
}

export interface ApiDescriptor {
  packageDir: PublishedPackageDir;
  packageName: string;
  exportKey: string;
  importPath: string;
  subpath: string;
  typesPath: string;
  slug: string;
  outputPath: string;
}

function packageManifest(packageDir: PublishedPackageDir): PackageManifest {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', packageDir, 'package.json'), 'utf8'),
  ) as PackageManifest;
}

function typesTarget(target: ExportTarget | undefined): string | null {
  if (!target || typeof target === 'string') return null;
  if (typeof target.types === 'string') return target.types;
  for (const nested of Object.values(target)) {
    const found = typesTarget(nested);
    if (found) return found;
  }
  return null;
}

function isInternalExport(exportKey: string): boolean {
  return exportKey
    .replace(/^\.\//, '')
    .split('/')
    .some((segment) => segment === 'internal');
}

function slugPart(value: string): string {
  return value
    .replace(/^@/, '')
    .replaceAll('/', '-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export function apiSlug(packageName: string, exportKey: string): string {
  const packageSlug = slugPart(packageName);
  if (exportKey === '.') return `${packageSlug}-reference-api`;
  return `${packageSlug}-${slugPart(exportKey.replace(/^\.\//, ''))}-reference-api`;
}

/**
 * Discover every released developer-facing declaration entry from package
 * manifests. There is no second allow-list of subpaths: every export must be
 * documented, explicitly unreleased, mechanically internal, or dispositioned
 * above as a non-user-facing adapter seam.
 */
export function discoverApiDescriptors(): ApiDescriptor[] {
  const descriptors: ApiDescriptor[] = [];
  for (const packageDir of PUBLISHED_PACKAGE_DIRS) {
    const manifest = packageManifest(packageDir);
    if (manifest.private) {
      throw new Error(`published package is marked private: packages/${packageDir}`);
    }
    if (!manifest.exports) {
      throw new Error(`published package has no export map: ${manifest.name}`);
    }
    const unreleased = new Set(manifest.pyricUnreleasedExports ?? []);
    for (const [exportKey, target] of Object.entries(manifest.exports)) {
      if (unreleased.has(exportKey)) continue;
      if (isInternalExport(exportKey)) continue;
      if (NON_USER_FACING_EXPORTS.has(`${packageDir}:${exportKey}`)) continue;
      const types = typesTarget(target);
      if (!types) {
        throw new Error(`${manifest.name} export ${exportKey} has no types target`);
      }
      const subpath = exportKey === '.' ? '' : exportKey.replace(/^\.\//, '');
      const importPath = subpath ? `${manifest.name}/${subpath}` : manifest.name;
      const slug = apiSlug(manifest.name, exportKey);
      descriptors.push({
        packageDir,
        packageName: manifest.name,
        exportKey,
        importPath,
        subpath,
        typesPath: join(REPO_ROOT, 'packages', packageDir, types),
        slug,
        outputPath: join(OUTPUT_ROOT, `${slug}.md`),
      });
    }
  }
  return descriptors;
}

interface TypeDocProject {
  children?: Array<{ name?: string }>;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function evidenceSlug(descriptor: ApiDescriptor): string | null {
  return canIUseImport(descriptor.importPath)?.evidenceSlug ?? null;
}

export function renderApiMarkdown(descriptor: ApiDescriptor, order: number): string {
  if (!existsSync(descriptor.typesPath)) {
    throw new Error(
      `missing declaration entry: ${descriptor.typesPath}\n  Build first: bun run build`,
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), 'pyric-api-docs-'));
  try {
    const jsonPath = join(tmp, 'reflection.json');
    const options = {
      entryPoints: [descriptor.typesPath],
      plugin: [
        'typedoc-plugin-markdown',
        join(HERE, 'typedoc-api-filter.mjs'),
      ],
      out: tmp,
      json: jsonPath,
      name: descriptor.importPath,
      readme: 'none',
      githubPages: false,
      skipErrorChecking: true,
      excludeInternal: true,
      excludePrivate: true,
      excludeExternals: true,
      disableSources: true,
      validation: {
        notExported: false,
        invalidLink: false,
      },
      outputFileStrategy: 'modules',
      hideBreadcrumbs: true,
      hidePageHeader: true,
      hidePageTitle: true,
      useHTMLAnchors: true,
      useCodeBlocks: true,
      expandObjects: true,
      expandParameters: true,
      typeDeclarationVisibility: 'verbose',
      parametersFormat: 'table',
      interfacePropertiesFormat: 'table',
      classPropertiesFormat: 'table',
      propertyMembersFormat: 'table',
      typeAliasPropertiesFormat: 'table',
      enumMembersFormat: 'table',
      indexFormat: 'table',
      tableColumnSettings: {
        hideInherited: true,
        hideSources: true,
        leftAlignHeaders: true,
      },
    };
    const optionsPath = join(tmp, 'typedoc.json');
    writeFileSync(optionsPath, JSON.stringify(options, null, 2));
    execFileSync('bunx', ['typedoc', '--options', optionsPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const body = readFileSync(join(tmp, 'README.md'), 'utf8')
      .replace(/[ \t]+$/gm, '')
      .replace(/\s+$/, '');
    const project = JSON.parse(readFileSync(jsonPath, 'utf8')) as TypeDocProject;
    const symbolCount = (project.children ?? []).filter(
      (child) => child.name && !child.name.startsWith('_'),
    ).length;
    const evidence = evidenceSlug(descriptor);
    const frontmatter = [
      '---',
      `title: ${yamlString(`API reference: ${descriptor.importPath}`)}`,
      `navLabel: ${yamlString(descriptor.importPath)}`,
      `description: ${yamlString(`Published declarations for ${descriptor.importPath}.`)}`,
      `group: ${yamlString(API_REFERENCE_GROUP)}`,
      `section: ${yamlString(descriptor.packageName)}`,
      `order: ${order}`,
      `slug: ${yamlString(descriptor.slug)}`,
      'kind: "api"',
      `apiPackage: ${yamlString(descriptor.packageName)}`,
      `apiImportPath: ${yamlString(descriptor.importPath)}`,
      `apiSubpath: ${yamlString(descriptor.subpath)}`,
      `apiSymbolCount: ${symbolCount}`,
      ...(evidence ? [`apiEvidenceSlug: ${yamlString(evidence)}`] : []),
      '---',
    ].join('\n');
    return `${frontmatter}\n\n${GENERATED_HEADER}\n\n${body}\n`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function renderApiIndex(descriptors: ApiDescriptor[]): string {
  const byPackage = new Map<string, ApiDescriptor[]>();
  for (const descriptor of descriptors) {
    const entries = byPackage.get(descriptor.packageName) ?? [];
    entries.push(descriptor);
    byPackage.set(descriptor.packageName, entries);
  }
  const body: string[] = [
    '---',
    'title: "API reference"',
    'navLabel: "API reference"',
    'description: "Published declarations for every supported Pyric package entry point."',
    `group: ${yamlString(API_REFERENCE_GROUP)}`,
    'section: ""',
    'order: 10',
    'slug: "api-reference"',
    'kind: "api-index"',
    '---',
    '',
    GENERATED_HEADER,
    '',
    '# API reference',
    '',
    'Find an import path, then open its generated declarations. These pages describe the published TypeScript contract. Behavioral fidelity and known gaps remain in Conformance.',
    '',
  ];
  for (const [packageName, entries] of byPackage) {
    body.push(`## \`${packageName}\``, '');
    for (const descriptor of entries) {
      body.push(`- [\`${descriptor.importPath}\`](./${descriptor.slug}.md)`);
    }
    body.push('');
  }
  return `${body.join('\n').replace(/\s+$/, '')}\n`;
}

function parseArgs(argv: string[]): {
  write: boolean;
  check: boolean;
  only: Set<string> | null;
} {
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

function selected(descriptors: ApiDescriptor[], only: Set<string> | null): ApiDescriptor[] {
  if (!only) return descriptors;
  return descriptors.filter((descriptor) => only.has(descriptor.importPath));
}

if (import.meta.main) {
  const { write, check, only } = parseArgs(process.argv.slice(2));
  const allDescriptors = discoverApiDescriptors();
  const descriptors = selected(allDescriptors, only);
  if (descriptors.length === 0) {
    console.error('No matching released descriptors. Use --only <package/subpath>.');
    process.exit(1);
  }

  // Stable per-route order (front matter) derived from position in the full
  // descriptor list, independent of any --only selection. The api-reference
  // index is order 10; pages follow, spaced by 10s.
  const orderBySlug = new Map(allDescriptors.map((d, i) => [d.slug, 20 + i * 10]));
  const indexPath = join(OUTPUT_ROOT, 'api-reference.md');

  if (write) {
    mkdirSync(OUTPUT_ROOT, { recursive: true });
    // No directory-wide cleanup: _generated is shared with the conformance
    // pages and is cleared as a whole by scripts/generate-content.ts before a
    // build. Here we only write the API-reference files this generator owns.
    if (!only) {
      writeFileSync(indexPath, renderApiIndex(descriptors));
    }
    for (const descriptor of descriptors) {
      writeFileSync(descriptor.outputPath, renderApiMarkdown(descriptor, orderBySlug.get(descriptor.slug)!));
      console.log(`Generated ${descriptor.outputPath.replace(`${REPO_ROOT}/`, '')}`);
    }
  }

  if (check) {
    const problems: string[] = [];
    if (!existsSync(indexPath)) problems.push('_generated/api-reference.md: missing');
    else if (readFileSync(indexPath, 'utf8') !== renderApiIndex(allDescriptors)) {
      problems.push('_generated/api-reference.md: drifted');
    }
    for (const descriptor of descriptors) {
      const rel = descriptor.outputPath.replace(`${REPO_ROOT}/`, '');
      const generated = renderApiMarkdown(descriptor, orderBySlug.get(descriptor.slug)!);
      if (!existsSync(descriptor.outputPath)) problems.push(`${rel}: missing`);
      else if (readFileSync(descriptor.outputPath, 'utf8') !== generated) {
        problems.push(`${rel}: drifted`);
      }
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`- ${problem}`);
      console.error('Run bun run docs:api:generate after bun run build.');
      process.exit(1);
    }
    console.log(`API reference matches published declarations (${allDescriptors.length} routes).`);
  }
}
