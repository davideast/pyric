/**
 * The generated API reference, as a library for the api-reference content
 * loader. TypeDoc runs in-process — one conversion over every released entry
 * point — and the markdown renders through typedoc-plugin-markdown's output
 * into a cache directory this module owns. No subprocesses, no temp-file
 * scraping, no options JSON.
 *
 * The inventory contract survives from the original generator: every export
 * in a published package's export map must be documented, explicitly
 * unreleased (`pyricUnreleasedExports`), mechanically internal (`/internal`),
 * or dispositioned below as a non-user-facing adapter seam. A new export that
 * is none of those fails the build.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeImport } from './native-import';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const SITE_ROOT = join(HERE, '..', '..');
/** TypeDoc's markdown output lands here; the loader reads it back and the
 * directory is disposable cache (gitignored with the rest of .astro). */
export const TYPEDOC_CACHE_DIR = join(SITE_ROOT, '.astro', 'typedoc-markdown');

export const API_REFERENCE_GROUP = 'API reference';

export const GENERATED_HEADER =
  '<!-- Generated from published package declarations via TypeDoc. Rendered by the api-reference content loader. -->';

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
 * manifests. There is no second allow-list of subpaths.
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
      descriptors.push({
        packageDir,
        packageName: manifest.name,
        exportKey,
        importPath,
        subpath,
        typesPath: join(REPO_ROOT, 'packages', packageDir, types),
        slug: apiSlug(manifest.name, exportKey),
      });
    }
  }
  return descriptors;
}

/** Stable per-route order derived from position in the full descriptor list.
 * The api-reference index is order 10; pages follow, spaced by 10s. */
export function apiOrderBySlug(allDescriptors: ApiDescriptor[]): Map<string, number> {
  return new Map(allDescriptors.map((d, i) => [d.slug, 20 + i * 10]));
}

export interface ApiPage {
  slug: string;
  data: Record<string, unknown>;
  body: string;
}

/** TypeDoc derives its initial module names from entry paths. Immediately
 * after conversion, renderAllApiPages renames every module to its route slug,
 * so output filenames and cross-module links speak the site's one canonical
 * vocabulary (`<slug>.md`). This helper exists only to perform that mapping
 * at the producer; nothing downstream reasons about TypeDoc's naming. */
function derivedEntryModuleName(descriptor: ApiDescriptor): string {
  const rel = relative(join(REPO_ROOT, 'packages'), descriptor.typesPath)
    .split(sep)
    .join('/');
  return rel.replace(/\/index\.d\.ts$/, '').replace(/\.d\.ts$/, '');
}

export function apiIndexPage(descriptors: ApiDescriptor[]): ApiPage {
  const byPackage = new Map<string, ApiDescriptor[]>();
  for (const descriptor of descriptors) {
    const entries = byPackage.get(descriptor.packageName) ?? [];
    entries.push(descriptor);
    byPackage.set(descriptor.packageName, entries);
  }
  const body: string[] = [
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
  return {
    slug: 'api-reference',
    data: {
      title: 'API reference',
      navLabel: 'API reference',
      description: 'Published declarations for every supported Pyric package entry point.',
      group: API_REFERENCE_GROUP,
      section: '',
      order: 10,
      slug: 'api-reference',
      kind: 'api-index',
    },
    body: `${body.join('\n').replace(/\s+$/, '')}\n`,
  };
}

/**
 * One in-process TypeDoc conversion over every released entry point, rendered
 * to markdown through typedoc-plugin-markdown's output. Returns the index
 * page plus one page per descriptor.
 */
export async function renderAllApiPages(): Promise<ApiPage[]> {
  const descriptors = discoverApiDescriptors();
  const missing = descriptors.filter((d) => !existsSync(d.typesPath));
  if (missing.length > 0) {
    throw new Error(
      'api-reference: packages are not built — missing declaration entries:\n' +
        missing.map((d) => `  ${d.importPath}: ${relative(REPO_ROOT, d.typesPath)}`).join('\n') +
        '\nBuild packages first, from the repo root:\n\n  bun run build --packages-only\n',
    );
  }

  const { Application, TSConfigReader } = await nativeImport<typeof import('typedoc')>('typedoc');
  const app = await Application.bootstrapWithPlugins(
    {
      entryPoints: descriptors.map((d) => d.typesPath),
      tsconfig: join(HERE, 'typedoc.tsconfig.json'),
      plugin: ['typedoc-plugin-markdown', join(HERE, 'typedoc-api-filter.mjs')],
      outputs: [{ name: 'markdown', path: TYPEDOC_CACHE_DIR }],
      readme: 'none',
      githubPages: false,
      skipErrorChecking: true,
      excludeInternal: true,
      excludePrivate: true,
      excludeExternals: true,
      disableSources: true,
      validation: { notExported: false, invalidLink: false },
      logLevel: 'Warn',
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
    } as never,
    [new TSConfigReader()],
  );
  const project = await app.convert();
  if (!project) throw new Error('api-reference: TypeDoc conversion failed');

  // Rename every module to its route slug before rendering: from here on the
  // markdown filenames, TypeDoc's cross-module links, and the symbol counts
  // all speak the site's one canonical vocabulary (`<slug>.md`).
  const slugByModuleName = new Map(
    descriptors.map((d) => [derivedEntryModuleName(d), d.slug]),
  );
  const symbolCounts = new Map<string, number>();
  for (const module of project.children ?? []) {
    const slug = slugByModuleName.get(module.name);
    if (!slug) {
      throw new Error(`api-reference: reflection module '${module.name}' matches no released entry point`);
    }
    module.name = slug;
    symbolCounts.set(
      slug,
      (module.children ?? []).filter((child) => child.name && !child.name.startsWith('_')).length,
    );
  }
  await app.generateOutputs(project);

  const conformance = await nativeImport<typeof import('@pyric/cli/conformance')>('@pyric/cli/conformance');
  const orderBySlug = apiOrderBySlug(descriptors);
  const pages: ApiPage[] = [apiIndexPage(descriptors)];
  for (const descriptor of descriptors) {
    const markdownPath = join(TYPEDOC_CACHE_DIR, `${descriptor.slug}.md`);
    if (!existsSync(markdownPath)) {
      throw new Error(
        `api-reference: TypeDoc produced no markdown for ${descriptor.importPath} (expected ${relative(SITE_ROOT, markdownPath)})`,
      );
    }
    const body = readFileSync(markdownPath, 'utf8')
      .replace(/[ \t]+$/gm, '')
      .replace(/\s+$/, '');
    const symbolCount = symbolCounts.get(descriptor.slug);
    if (symbolCount === undefined) {
      throw new Error(`api-reference: no reflection module for ${descriptor.importPath}`);
    }
    const evidence = conformance.canIUseImport(descriptor.importPath)?.evidenceSlug ?? null;
    pages.push({
      slug: descriptor.slug,
      data: {
        title: `API reference: ${descriptor.importPath}`,
        navLabel: descriptor.importPath,
        description: `Published declarations for ${descriptor.importPath}.`,
        group: API_REFERENCE_GROUP,
        section: descriptor.packageName,
        order: orderBySlug.get(descriptor.slug),
        slug: descriptor.slug,
        kind: 'api',
        apiPackage: descriptor.packageName,
        apiImportPath: descriptor.importPath,
        apiSubpath: descriptor.subpath,
        apiSymbolCount: symbolCount,
        ...(evidence ? { apiEvidenceSlug: evidence } : {}),
      },
      body: `${GENERATED_HEADER}\n\n${body}\n`,
    });
  }
  return pages;
}
