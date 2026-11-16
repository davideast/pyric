/**
 * Equivalence-class grammar for Vite dev-server HTTP request path spellings:
 * slash/dot/traversal/backslash prefixes x `@fs` vs root-relative forms x
 * Vite `base` compositions x query suffixes.
 */
import { cartesian2, cartesian3 } from './combinators.js';

interface PrefixSpelling {
  readonly id: string;
  readonly prefix: string;
}

interface FsMarkerSpelling {
  readonly id: string;
  readonly marker: string;
}

interface QuerySpelling {
  readonly id: string;
  readonly suffix: string;
}

export interface GeneratedUrlPathCase {
  readonly id: string;
  readonly rawTarget: string;
}

const PREFIX_SPELLINGS: readonly PrefixSpelling[] = [
  { id: 'single-slash', prefix: '/' },
  { id: 'double-slash', prefix: '//' },
  { id: 'triple-slash', prefix: '///' },
  { id: 'dot-seg', prefix: '/./' },
  { id: 'parent-seg', prefix: '/items/../' },
  { id: 'double-parent-seg', prefix: '/items//../../' },
  { id: 'encoded-dot-lower', prefix: '/%2e/' },
  { id: 'encoded-dot-upper', prefix: '/%2E/' },
  { id: 'encoded-parent', prefix: '/items/%2e%2e/' },
  { id: 'raw-backslash', prefix: '/\\' },
  { id: 'encoded-backslash', prefix: '/%5c' },
];

const FS_MARKER_SPELLINGS: readonly FsMarkerSpelling[] = [
  { id: 'at-fs', marker: '@fs/' },
  { id: 'pct40-fs', marker: '%40fs/' },
  { id: 'at-fs-pct2f', marker: '@fs%2f' },
  { id: 'pct40-fs-pct2f', marker: '%40fs%2f' },
  { id: 'at-id-at-fs', marker: '@id/@fs/' },
  { id: 'pct40-id-at-fs', marker: '%40id/@fs/' },
];

const QUERY_SPELLINGS: readonly QuerySpelling[] = [
  { id: 'no-query', suffix: '' },
  { id: 'raw-query', suffix: '?raw' },
  { id: 'import-query', suffix: '?import' },
  { id: 'ver-query', suffix: '?v=abc123' },
  { id: 'ver-amp-query', suffix: '?v=abc123&' },
];

function stripLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, '');
}

function normalizeBaseSegment(base: string): string {
  return base.replace(/^\/+|\/+$/g, '');
}

/**
 * Systematically generates equivalent HTTP request targets for a file via:
 *  1. `PREFIX_SPELLINGS` x `FS_MARKER_SPELLINGS` targeting `absFilePath`,
 *  2. `PREFIX_SPELLINGS` targeting `rootRelativePath` (when inside served root),
 *  3. Query suffix variations across canonical and non-canonical prefixes, and
 *  4. Base-prefix compositions when `base` is non-root (e.g. `'/app/'`).
 */
export function generateEquivalentViteUrls(input: {
  absFilePath: string;
  rootRelativePath?: string;
  base?: string;
}): GeneratedUrlPathCase[] {
  const cleanAbs = stripLeadingSlashes(input.absFilePath);
  const baseSeg = normalizeBaseSegment(input.base ?? '/');
  const out: GeneratedUrlPathCase[] = [];
  const seen = new Set<string>();

  const pushUnique = (entry: GeneratedUrlPathCase): void => {
    if (seen.has(entry.rawTarget)) return;
    seen.add(entry.rawTarget);
    out.push(entry);
  };

  if (baseSeg === '') {
    for (const [pref, fsMark] of cartesian2(PREFIX_SPELLINGS, FS_MARKER_SPELLINGS)) {
      pushUnique({
        id: `fs-${pref.id}-${fsMark.id}`,
        rawTarget: `${pref.prefix}${fsMark.marker}${cleanAbs}`,
      });
    }

    const queryPrefixes = PREFIX_SPELLINGS.filter((p) =>
      ['single-slash', 'double-slash', 'dot-seg', 'parent-seg', 'encoded-dot-lower'].includes(p.id),
    );
    for (const [pref, q] of cartesian2(queryPrefixes, QUERY_SPELLINGS)) {
      if (q.suffix === '') continue;
      pushUnique({
        id: `fs-q-${pref.id}-${q.id}`,
        rawTarget: `${pref.prefix}@fs/${cleanAbs}${q.suffix}`,
      });
    }

    if (input.rootRelativePath !== undefined) {
      const cleanRel = stripLeadingSlashes(input.rootRelativePath);
      for (const [pref, q] of cartesian2(PREFIX_SPELLINGS, QUERY_SPELLINGS)) {
        if (
          q.suffix !== '' &&
          !['single-slash', 'double-slash', 'dot-seg', 'parent-seg'].includes(pref.id)
        ) {
          continue;
        }
        pushUnique({
          id: `rel-${pref.id}-${q.id}`,
          rawTarget: `${pref.prefix}${cleanRel}${q.suffix}`,
        });
      }
    }
    return out;
  }

  const basePlacements: ReadonlyArray<{ id: string; render: (subpath: string) => string }> = [
    { id: 'under-base', render: (sub) => `/${baseSeg}${sub}` },
    { id: 'double-slash-base', render: (sub) => `//${baseSeg}${sub}` },
    { id: 'dot-before-base', render: (sub) => `/./${baseSeg}${sub}` },
    { id: 'parent-before-base', render: (sub) => `/items/../${baseSeg}${sub}` },
  ];
  const baseSubPrefixes = PREFIX_SPELLINGS.filter((p) =>
    ['single-slash', 'double-slash', 'dot-seg', 'parent-seg', 'encoded-dot-lower'].includes(p.id),
  );
  const baseQueries = QUERY_SPELLINGS.filter(
    (q) => q.id === 'no-query' || q.id === 'raw-query' || q.id === 'ver-query',
  );

  for (const [bp, pref, q] of cartesian3(basePlacements, baseSubPrefixes, baseQueries)) {
    const fsSubpath = `${pref.prefix}@fs/${cleanAbs}${q.suffix}`;
    pushUnique({
      id: `base-fs-${bp.id}-${pref.id}-${q.id}`,
      rawTarget: bp.render(fsSubpath),
    });

    if (input.rootRelativePath !== undefined) {
      const cleanRel = stripLeadingSlashes(input.rootRelativePath);
      const relSubpath = `${pref.prefix}${cleanRel}${q.suffix}`;
      pushUnique({
        id: `base-rel-${bp.id}-${pref.id}-${q.id}`,
        rawTarget: bp.render(relSubpath),
      });
    }
  }

  return out;
}
