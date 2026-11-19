import { defineRows, type DefineRowsConfig, type RowSeed } from './define-rows.ts';
import type {
  CompatibilityDocBlock,
  CompatibilityRow,
  CompatibilityTableBlock,
  MarkdownBlock,
  Surface,
} from './types.ts';

type SeedFields = Omit<CompatibilityRow, 'id'>;

const SECTION_FILE = 'section.ts';
const ROW_FILE_PATTERN = /^[A-Za-z0-9]+([.-][A-Za-z0-9]+)*\.ts$/;
const FORBIDDEN_ROW_FILE_SUFFIXES: readonly string[] = [
  '.test.ts',
  '.spec.ts',
  '.d.ts',
  '.generated.ts',
];
const SECTION_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AUTHORED_ROW_BRAND = Symbol.for('pyric.conformance.authoredRowRecord');
const SECTION_BRAND = Symbol.for('pyric.conformance.rowSection');
const MARKDOWN_SECTION_BRAND = Symbol.for('pyric.conformance.markdownSection');

export type RegistryEntryKind = 'file' | 'directory' | 'missing' | 'other';

/** Host boundary for reading a surface registry directory tree. */
export interface RegistryDirectoryHost {
  readDirectory(dirPath: string): readonly string[];
  entryKind(entryPath: string): RegistryEntryKind;
  loadModule(filePath: string): unknown;
}

export type FileRowSeed<D extends Partial<SeedFields>> = Omit<RowSeed<D>, 'rowRef'> & {
  rowRef?: never;
  id?: never;
  /** Optional within-section sort key; omit on new rows to sort after ordered rows by rowRef. */
  order?: number;
};

export interface AuthoredRowRecord {
  readonly [AUTHORED_ROW_BRAND]: true;
  readonly order: number;
  readonly build: (rowRef: string) => CompatibilityRow;
}

export type RowRefSeedFactory<D extends Partial<SeedFields>> = (
  rowRef: string,
) => Omit<FileRowSeed<D>, 'order'>;

export interface RowSectionConfig<D extends Partial<SeedFields>> extends DefineRowsConfig<D> {
  order: number;
  prefix?: string;
  publishInCompatibilityDocs?: false;
}

export interface RowSection<D extends Partial<SeedFields>> {
  readonly [SECTION_BRAND]: true;
  readonly surface: Surface;
  readonly order: number;
  readonly prefix: string;
  readonly publishInCompatibilityDocs?: false;
  readonly row: (seed: FileRowSeed<D>) => AuthoredRowRecord;
  readonly rowFromRef: (
    order: number | undefined,
    deriveSeed: RowRefSeedFactory<D>,
  ) => AuthoredRowRecord;
}

export interface MarkdownSectionConfig {
  order: number;
  markdown: string;
}

export interface MarkdownSection {
  readonly [MARKDOWN_SECTION_BRAND]: true;
  readonly order: number;
  readonly markdown: string;
}

export interface LoadRegistrySectionsOptions {
  readonly ignoreFiles?: ReadonlySet<string>;
}

export interface LoadedRegistrySections {
  readonly blocks: CompatibilityTableBlock[];
  readonly contentBlocks: CompatibilityDocBlock[];
  rowsOf(sectionSlug: string): CompatibilityRow[];
}

function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function joinChildPath(parent: string, child: string): string {
  if (parent.endsWith('/')) {
    return `${parent}${child}`;
  }
  return `${parent}/${child}`;
}

function isFiniteOrderNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRowSectionDescriptor(value: unknown): value is RowSection<Partial<SeedFields>> {
  if (!isPlainObject(value)) return false;
  return (value as Record<symbol, unknown>)[SECTION_BRAND] === true;
}

function isMarkdownSectionDescriptor(value: unknown): value is MarkdownSection {
  if (!isPlainObject(value)) return false;
  return (value as Record<symbol, unknown>)[MARKDOWN_SECTION_BRAND] === true;
}

function isAuthoredRowRecord(value: unknown): value is AuthoredRowRecord {
  if (!isPlainObject(value)) return false;
  return (value as Record<symbol, unknown>)[AUTHORED_ROW_BRAND] === true;
}

function isValidSectionSlug(name: string): boolean {
  return SECTION_SLUG_PATTERN.test(name);
}

function isValidRowFileName(fileName: string): boolean {
  if (!ROW_FILE_PATTERN.test(fileName)) {
    return false;
  }
  const lower = fileName.toLowerCase();
  for (const suffix of FORBIDDEN_ROW_FILE_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return false;
    }
  }
  return true;
}

function resolveSectionPrefix<D extends Partial<SeedFields>>(config: RowSectionConfig<D>): string {
  if (config.prefix !== undefined) {
    return config.prefix;
  }
  const sectionTitle = config.defaults?.section;
  if (typeof sectionTitle === 'string' && sectionTitle.trim() !== '') {
    return `## ${sectionTitle}\n`;
  }
  return '';
}

function resolveRowOrder(rawOrder: unknown): number {
  if (rawOrder === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  if (!isFiniteOrderNumber(rawOrder)) {
    throw new Error("'order' on a row record must be a finite number when provided");
  }
  return rawOrder;
}

export function defineRowSection<const D extends Partial<SeedFields>>(
  config: RowSectionConfig<D>,
): RowSection<D> {
  if (!isFiniteOrderNumber(config.order)) {
    throw new Error(`defineRowSection(${config.surface}): 'order' must be a finite number`);
  }
  const prefix = resolveSectionPrefix(config);
  if (prefix.trim() === '') {
    throw new Error(`defineRowSection(${config.surface}): provide 'defaults.section' or non-empty 'prefix'`);
  }
  const buildFromSeed = defineRows(config);

  const descriptor: {
    [SECTION_BRAND]: true;
    surface: Surface;
    order: number;
    prefix: string;
    publishInCompatibilityDocs?: false;
    row: (seed: FileRowSeed<D>) => AuthoredRowRecord;
    rowFromRef: (order: number | undefined, deriveSeed: RowRefSeedFactory<D>) => AuthoredRowRecord;
  } = {
    [SECTION_BRAND]: true,
    surface: config.surface,
    order: config.order,
    prefix,
    row(seed: FileRowSeed<D>): AuthoredRowRecord {
      const raw = seed as Record<string, unknown>;
      if ('rowRef' in raw && raw.rowRef !== undefined) {
        throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
      }
      if ('id' in raw && raw.id !== undefined) {
        throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
      }
      const resolvedOrder = resolveRowOrder(raw.order);
      const { order: _order, rowRef: _rowRef, id: _id, ...rest } = seed;
      return {
        [AUTHORED_ROW_BRAND]: true,
        order: resolvedOrder,
        build(rowRef: string): CompatibilityRow {
          const fullSeed = { ...rest, rowRef } as unknown as RowSeed<D>;
          return buildFromSeed(fullSeed);
        },
      };
    },
    rowFromRef(order: number | undefined, deriveSeed: RowRefSeedFactory<D>): AuthoredRowRecord {
      const resolvedOrder = resolveRowOrder(order);
      return {
        [AUTHORED_ROW_BRAND]: true,
        order: resolvedOrder,
        build(rowRef: string): CompatibilityRow {
          const derived = deriveSeed(rowRef);
          const raw = derived as Record<string, unknown>;
          if ('rowRef' in raw && raw.rowRef !== undefined) {
            throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
          }
          if ('id' in raw && raw.id !== undefined) {
            throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
          }
          const { rowRef: _rowRef, id: _id, ...rest } = derived;
          const fullSeed = { ...rest, rowRef } as unknown as RowSeed<D>;
          return buildFromSeed(fullSeed);
        },
      };
    },
  };

  if (config.publishInCompatibilityDocs === false) {
    descriptor.publishInCompatibilityDocs = false;
  }

  return descriptor;
}

export function defineMarkdownSection(config: MarkdownSectionConfig): MarkdownSection {
  if (!isFiniteOrderNumber(config.order)) {
    throw new Error("defineMarkdownSection: 'order' must be a finite number");
  }
  if (typeof config.markdown !== 'string' || config.markdown.trim() === '') {
    throw new Error("defineMarkdownSection: 'markdown' must be a non-empty string");
  }
  return {
    [MARKDOWN_SECTION_BRAND]: true,
    order: config.order,
    markdown: config.markdown,
  };
}

function extractSectionDescriptor(
  moduleExports: unknown,
  sectionFilePath: string,
): RowSection<Partial<SeedFields>> | MarkdownSection {
  if (!isPlainObject(moduleExports)) {
    throw new Error(`${sectionFilePath}: module did not evaluate to an exports object`);
  }
  let candidate: unknown = moduleExports.section;
  if (candidate === undefined) {
    candidate = moduleExports.default;
  }
  if (!isRowSectionDescriptor(candidate) && !isMarkdownSectionDescriptor(candidate)) {
    throw new Error(
      `${sectionFilePath}: must export 'section = defineRowSection(...)' or 'section = defineMarkdownSection(...)'`,
    );
  }
  return candidate;
}

function extractDefaultRowRecord(moduleExports: unknown, rowFilePath: string): AuthoredRowRecord {
  if (!isPlainObject(moduleExports)) {
    throw new Error(`${rowFilePath}: row module must default-export 'row({ ... })'`);
  }
  const defaultExport = moduleExports.default;
  if (!isAuthoredRowRecord(defaultExport)) {
    throw new Error(`${rowFilePath}: row file must default-export 'row({ ... })' from './section.ts'`);
  }
  return defaultExport;
}

export function assembleRegistrySections(
  surfaceDir: string,
  host: RegistryDirectoryHost,
  options?: LoadRegistrySectionsOptions,
): LoadedRegistrySections {
  const ignoredFiles = options?.ignoreFiles ?? new Set<string>();
  for (const ignoredName of ignoredFiles) {
    const ignoredPath = joinChildPath(surfaceDir, ignoredName);
    const kind = host.entryKind(ignoredPath);
    if (kind !== 'file') {
      throw new Error(`${ignoredPath}: ignored entry '${ignoredName}' must be an existing regular file`);
    }
  }

  const topEntries = [...host.readDirectory(surfaceDir)].sort(compareCodePoint);
  const loadedSections: Array<{ slug: string; order: number; block: CompatibilityTableBlock }> = [];
  const loadedContentBlocks: Array<{ slug: string; order: number; block: CompatibilityDocBlock }> = [];
  const rowsBySlug = new Map<string, CompatibilityRow[]>();
  const seenRowRefsBySurfaceAndLower = new Map<string, Map<string, string>>();

  for (const entry of topEntries) {
    if (ignoredFiles.has(entry)) continue;
    const sectionDirPath = joinChildPath(surfaceDir, entry);
    const entryType = host.entryKind(sectionDirPath);
    if (entryType !== 'directory') {
      throw new Error(`${sectionDirPath}: unexpected non-directory entry in surface registry directory`);
    }
    if (!isValidSectionSlug(entry)) {
      throw new Error(`${sectionDirPath}: section directory slug '${entry}' must be lowercase kebab-case`);
    }

    const sectionFilePath = joinChildPath(sectionDirPath, SECTION_FILE);
    if (host.entryKind(sectionFilePath) !== 'file') {
      throw new Error(`${sectionFilePath}: missing required section descriptor file`);
    }
    const section = extractSectionDescriptor(host.loadModule(sectionFilePath), sectionFilePath);
    const sectionEntries = [...host.readDirectory(sectionDirPath)].sort(compareCodePoint);

    if (isMarkdownSectionDescriptor(section)) {
      for (const fileName of sectionEntries) {
        if (fileName === SECTION_FILE) continue;
        const extraPath = joinChildPath(sectionDirPath, fileName);
        throw new Error(`${extraPath}: markdown section directory must contain only ${SECTION_FILE}`);
      }
      const mdBlock: MarkdownBlock = {
        kind: 'markdown',
        markdown: section.markdown,
      };
      loadedContentBlocks.push({ slug: entry, order: section.order, block: mdBlock });
      continue;
    }

    const builtRows: Array<{ order: number; row: CompatibilityRow }> = [];

    for (const fileName of sectionEntries) {
      if (fileName === SECTION_FILE) continue;
      const rowFilePath = joinChildPath(sectionDirPath, fileName);
      const fileKind = host.entryKind(rowFilePath);
      if (fileKind !== 'file') {
        throw new Error(`${rowFilePath}: unexpected non-file entry inside section directory`);
      }
      if (!isValidRowFileName(fileName)) {
        throw new Error(
          `${rowFilePath}: invalid row filename '${fileName}'; expected <rowRef>.ts matching ^[A-Za-z0-9]+([.-][A-Za-z0-9]+)*\\.ts$ (excluding .test.ts, .spec.ts, .d.ts, and .generated.ts)`,
        );
      }

      const rowRef = fileName.slice(0, -'.ts'.length);
      const record = extractDefaultRowRecord(host.loadModule(rowFilePath), rowFilePath);
      const row = record.build(rowRef);
      const surfaceKey = row.surface.toLowerCase();
      let seenForSurface = seenRowRefsBySurfaceAndLower.get(surfaceKey);
      if (seenForSurface === undefined) {
        seenForSurface = new Map<string, string>();
        seenRowRefsBySurfaceAndLower.set(surfaceKey, seenForSurface);
      }
      const lowerKey = rowRef.toLowerCase();
      const priorPath = seenForSurface.get(lowerKey);
      if (priorPath !== undefined) {
        throw new Error(
          `${rowFilePath}: duplicate or case-colliding rowRef '${rowRef}' for surface '${row.surface}' (already defined at ${priorPath})`,
        );
      }
      seenForSurface.set(lowerKey, rowFilePath);

      builtRows.push({ order: record.order, row });
    }

    if (builtRows.length === 0) {
      throw new Error(`${sectionDirPath}: section contains no row files`);
    }

    builtRows.sort((left, right) => {
      const orderDiff = left.order - right.order;
      if (orderDiff !== 0) return orderDiff;
      return compareCodePoint(left.row.rowRef, right.row.rowRef);
    });

    const rows = builtRows.map((item) => item.row);
    const block: CompatibilityTableBlock = {
      kind: 'table',
      prefix: section.prefix,
      rows,
    };
    if (section.publishInCompatibilityDocs === false) {
      block.publishInCompatibilityDocs = false;
    }

    loadedSections.push({ slug: entry, order: section.order, block });
    loadedContentBlocks.push({ slug: entry, order: section.order, block });
    rowsBySlug.set(entry, rows);
  }

  loadedSections.sort((left, right) => {
    const orderDiff = left.order - right.order;
    if (orderDiff !== 0) return orderDiff;
    return compareCodePoint(left.slug, right.slug);
  });

  loadedContentBlocks.sort((left, right) => {
    const orderDiff = left.order - right.order;
    if (orderDiff !== 0) return orderDiff;
    return compareCodePoint(left.slug, right.slug);
  });

  return {
    blocks: loadedSections.map((item) => item.block),
    contentBlocks: loadedContentBlocks.map((item) => item.block),
    rowsOf(sectionSlug: string): CompatibilityRow[] {
      const rows = rowsBySlug.get(sectionSlug);
      if (rows === undefined) {
        throw new Error(`unknown registry section '${sectionSlug}' in ${surfaceDir}`);
      }
      return rows;
    },
  };
}
