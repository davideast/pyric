/**
 * MIME/constraint synthesis and site-level classification for Cloud Storage
 * assurance probes.
 */
import { re2FullMatch } from '@pyric/rules/internal';
import type { AccessSite } from '../code/types.js';
import {
  parseResourcePattern,
  resourceShapeKey,
} from '../../sandbox/internal/resource-pattern.js';
import type {
  RuleSurfaceEntry,
  StorageMetadataConstraint,
} from '../rules/rule-surface.js';
import type { FindingOp } from './types.js';

const CANDIDATE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/avif',
  'image/bmp',
  'image/svg+xml',
  'image/x-icon',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/html',
  'application/json',
  'application/xml',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'application/zip',
  'application/octet-stream',
];

export const STORAGE_UPLOAD_OPS = new Set(['uploadBytes', 'uploadBytesResumable', 'uploadString', 'save']);
export const STORAGE_UPDATE_OPS = new Set(['updateMetadata', 'setMetadata']);
export const STORAGE_DELETE_OPS = new Set(['deleteObject', 'deleteFiles']);
export const STORAGE_LIST_OPS = new Set(['list', 'listAll', 'getFiles']);
export const STORAGE_READ_OPS = new Set([
  'getBytes',
  'getBlob',
  'getStream',
  'getDownloadURL',
  'getMetadata',
  'download',
  'list',
  'listAll',
  'getFiles',
]);

const SAMPLE_CHARS = [
  'a',
  '1',
  'A',
  'x',
  '0',
  '-',
  '_',
  '.',
  '+',
  '/',
  ' ',
];

function safeMatchesContentType(pattern: string, subject: string): boolean | null {
  try {
    return re2FullMatch(pattern, subject);
  } catch {
    return null;
  }
}

function normalizeContentTypeConjuncts(
  pattern: string | undefined,
  conjuncts?: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  if (conjuncts !== undefined && conjuncts.length > 0) return conjuncts;
  if (pattern === undefined || pattern.length === 0) return [];
  if (pattern.includes(' && ')) {
    return pattern.split(' && ').map((part) => [part]);
  }
  return [[pattern]];
}

function sampleCharClass(charClass: string): string {
  if (safeMatchesContentType(charClass, '') === null) return 'x';
  for (const ch of SAMPLE_CHARS) {
    if (safeMatchesContentType(charClass, ch) === true) return ch;
  }
  for (let code = 32; code <= 126; code += 1) {
    const ch = String.fromCharCode(code);
    if (safeMatchesContentType(charClass, ch) === true) return ch;
  }
  return 'x';
}

function clampRepeatCount(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return Math.min(parsed, 64);
}

/** True when `contentType` matches the Storage `.matches(...)` pattern/conjuncts (or when none are set). */
export function contentTypeMatchesPattern(
  contentType: string,
  pattern: string | undefined,
  conjuncts?: readonly (readonly string[])[],
): boolean {
  const norm = normalizeContentTypeConjuncts(pattern, conjuncts);
  if (norm.length === 0) return true;
  return norm.every((disjuncts) =>
    disjuncts.some((pat) => safeMatchesContentType(pat, contentType) === true),
  );
}

function expandContentTypePatternVariant(
  pattern: string,
  options: { dropOptionalGroups: boolean; spaceStarAsSpace: boolean },
): string {
  let candidate = pattern
    .replace(/^(?:\\A|\^)+/, '')
    .replace(/(?:\\z|\$)+$/, '')
    .replace(/^\(\?[a-z-]+\)/i, '')
    .replace(/^(?:\\A|\^)+/, '')
    .replace(/(?:\\z|\$)+$/, '');
  if (options.dropOptionalGroups) {
    for (let i = 0; i < 6; i += 1) {
      const next = candidate.replace(/\((?:\?:)?[^()]*\)\?/g, '');
      if (next === candidate) break;
      candidate = next;
    }
  }
  for (let i = 0; i < 6; i += 1) {
    const next = candidate.replace(/\((?:\?:)?([^()|]+)(?:\|[^()]*)+\)/g, '($1)');
    if (next === candidate) break;
    candidate = next;
  }
  let spaceOptional = '';
  if (options.spaceStarAsSpace) spaceOptional = ' ';
  return candidate
    .replace(
      /(\[\^\[:[^\]]+:\]\]|\[\[:[^\]]+:\]\]|\[\^[^\]]+\]|\[[^\]]+\])\{(\d+)(?:,\d*)?\}/g,
      (_m, cls: string, min: string) => sampleCharClass(cls).repeat(clampRepeatCount(min)),
    )
    .replace(/\\s\{(\d+)(?:,\d*)?\}/g, (_m, min: string) => ' '.repeat(clampRepeatCount(min)))
    .replace(/\\d\{(\d+)(?:,\d*)?\}/g, (_m, min: string) => '1'.repeat(clampRepeatCount(min)))
    .replace(/\\w\{(\d+)(?:,\d*)?\}/g, (_m, min: string) => 'a'.repeat(clampRepeatCount(min)))
    .replace(/\\(.)\{(\d+)(?:,\d*)?\}/g, (_m, ch: string, min: string) =>
      ch.repeat(clampRepeatCount(min)),
    )
    .replace(/\((?:\?:)?([^()]+)\)\{(\d+)(?:,\d*)?\}/g, (_m, grp: string, min: string) =>
      grp.repeat(clampRepeatCount(min)),
    )
    .replace(/\.{(\d+)(?:,\d*)?\}/g, (_m, min: string) => 'a'.repeat(clampRepeatCount(min)))
    .replace(/([^\\[\]()+*?{}])\{(\d+)(?:,\d*)?\}/g, (_m, ch: string, min: string) =>
      ch.repeat(clampRepeatCount(min)),
    )
    .replace(/\\s\+/g, ' ')
    .replace(/\\s\*/g, spaceOptional)
    .replace(/\\s\?/g, spaceOptional)
    .replace(/\\s/g, ' ')
    .replace(/\\d[+*]?/g, '1')
    .replace(/\\w[+*]?/g, 'a')
    .replace(
      /(\[\^\[:[^\]]+:\]\]|\[\[:[^\]]+:\]\]|\[\^[^\]]+\]|\[[^\]]+\])[+*]?/g,
      (_m, cls: string) => sampleCharClass(cls),
    )
    .replace(/(?<!\\)\.\+/g, 'a')
    .replace(/(?<!\\)\.\*/g, 'a')
    .replace(/(?<!\\)[?+*]/g, '')
    .replace(/(?<!\\)\(\?:/g, '(')
    .replace(/(?<!\\)[()]/g, '')
    .replace(/\\([./\-+?*()])/g, '$1');
}

const MAX_PROBE_ALLOCATION_BYTES = 64 * 1024 * 1024;

function extractLiteralPrefix(rawPattern: string): string | undefined {
  const stripped = rawPattern
    .replace(/^(?:\\A|\^)+/, '')
    .replace(/(?:\\z|\$)+$/, '');
  const m = /^([A-Za-z0-9.+/-]+?)\.[+*]$/.exec(stripped);
  if (!m) return undefined;
  return m[1]!.replace(/\\([./\-+])/g, '$1');
}

function extractLiteralSuffix(rawPattern: string): string | undefined {
  const stripped = rawPattern
    .replace(/^(?:\\A|\^)+/, '')
    .replace(/(?:\\z|\$)+$/, '');
  const m = /^\.[+*]([A-Za-z0-9.+/-]+)$/.exec(stripped);
  if (!m) return undefined;
  return m[1]!.replace(/\\([./\-+])/g, '$1');
}

/** Synthesize a concrete MIME `contentType` string satisfying a Storage `.matches(...)` regex or conjunct set. */
export function synthesizeMatchingContentType(
  pattern: string | undefined,
  conjuncts?: readonly (readonly string[])[],
): string {
  const norm = normalizeContentTypeConjuncts(pattern, conjuncts);
  if (norm.length === 0) return 'application/octet-stream';
  for (const disjuncts of norm) {
    if (disjuncts.every((p) => safeMatchesContentType(p, '') === null)) {
      return 'application/octet-stream';
    }
  }
  const matchesAll = (candidate: string): boolean =>
    norm.every((disjuncts) =>
      disjuncts.some((p) => safeMatchesContentType(p, candidate) === true),
    );

  for (const candidate of CANDIDATE_MIMES) {
    if (matchesAll(candidate)) return candidate;
  }
  const variants: Array<{ dropOptionalGroups: boolean; spaceStarAsSpace: boolean }> = [
    { dropOptionalGroups: false, spaceStarAsSpace: true },
    { dropOptionalGroups: true, spaceStarAsSpace: true },
    { dropOptionalGroups: false, spaceStarAsSpace: false },
    { dropOptionalGroups: true, spaceStarAsSpace: false },
  ];
  for (const disjuncts of norm) {
    for (const pat of disjuncts) {
      for (const variant of variants) {
        const candidate = expandContentTypePatternVariant(pat, variant);
        if (matchesAll(candidate)) return candidate;
      }
    }
  }
  if (norm.length > 1) {
    const prefixes: string[] = [];
    const suffixes: string[] = [];
    for (const disjuncts of norm) {
      for (const pat of disjuncts) {
        const pfx = extractLiteralPrefix(pat);
        if (pfx !== undefined && !prefixes.includes(pfx)) prefixes.push(pfx);
        const sfx = extractLiteralSuffix(pat);
        if (sfx !== undefined && !suffixes.includes(sfx)) suffixes.push(sfx);
      }
    }
    for (const pfx of prefixes) {
      for (const sfx of suffixes) {
        for (const sep of ['', 'x', 'x-', '/']) {
          const candidate = `${pfx}${sep}${sfx}`;
          if (matchesAll(candidate)) return candidate;
        }
      }
    }
  }
  return 'application/octet-stream';
}

export function compliantByteSize(
  maxSizeBytes: number | undefined,
  minSizeBytes?: number,
): number {
  let minFloor: number | undefined;
  if (minSizeBytes !== undefined && Number.isFinite(minSizeBytes)) {
    minFloor = Math.max(0, Math.ceil(minSizeBytes));
  }
  if (maxSizeBytes === undefined) {
    if (minFloor !== undefined) {
      return Math.min(MAX_PROBE_ALLOCATION_BYTES, Math.max(16, minFloor));
    }
    return 16;
  }
  if (maxSizeBytes <= 0) return 0;
  const maxCeil = Math.floor(maxSizeBytes);
  const desired = Math.max(minFloor ?? 1, Math.min(Math.max(16, minFloor ?? 1), maxCeil));
  return Math.min(MAX_PROBE_ALLOCATION_BYTES, desired);
}

export function mergedStorageConstraint(entries: readonly RuleSurfaceEntry[]): StorageMetadataConstraint {
  let contentTypePattern: string | undefined;
  const contentTypeConjuncts: (readonly string[])[] = [];
  let minSizeBytes: number | undefined;
  let maxSizeBytes: number | undefined;
  const requiredKeys = new Set<string>();
  let ownerMetadataKey: string | undefined;

  const pushConjunct = (disjuncts: readonly string[]): void => {
    const sig = disjuncts.join('||');
    if (!contentTypeConjuncts.some((existing) => existing.join('||') === sig)) {
      contentTypeConjuncts.push([...disjuncts]);
    }
  };

  for (const entry of entries) {
    const meta = entry.storageMetadata;
    if (!meta) continue;
    if (contentTypePattern === undefined && meta.contentTypePattern !== undefined) {
      contentTypePattern = meta.contentTypePattern;
    }
    if (meta.contentTypeConjuncts && meta.contentTypeConjuncts.length > 0) {
      for (const c of meta.contentTypeConjuncts) pushConjunct(c);
    } else if (meta.contentTypePattern !== undefined) {
      for (const c of normalizeContentTypeConjuncts(meta.contentTypePattern)) pushConjunct(c);
    }
    if (meta.minSizeBytes !== undefined) {
      if (minSizeBytes === undefined || meta.minSizeBytes > minSizeBytes) {
        minSizeBytes = meta.minSizeBytes;
      }
    }
    if (meta.maxSizeBytes !== undefined) {
      if (maxSizeBytes === undefined || meta.maxSizeBytes < maxSizeBytes) {
        maxSizeBytes = meta.maxSizeBytes;
      }
    }
    for (const key of meta.requiredCustomMetadataKeys ?? []) requiredKeys.add(key);
    if (ownerMetadataKey === undefined && meta.ownerMetadataKey !== undefined) {
      ownerMetadataKey = meta.ownerMetadataKey;
    }
  }

  const out: {
    contentTypePattern?: string;
    contentTypeConjuncts?: readonly (readonly string[])[];
    minSizeBytes?: number;
    maxSizeBytes?: number;
    requiredCustomMetadataKeys?: readonly string[];
    ownerMetadataKey?: string;
  } = {};
  if (contentTypeConjuncts.length > 1) {
    out.contentTypeConjuncts = contentTypeConjuncts;
    out.contentTypePattern = contentTypeConjuncts.map((c) => c.join('||')).join(' && ');
  } else if (contentTypePattern !== undefined) {
    out.contentTypePattern = contentTypePattern;
  }
  if (minSizeBytes !== undefined) out.minSizeBytes = minSizeBytes;
  if (maxSizeBytes !== undefined) out.maxSizeBytes = maxSizeBytes;
  if (requiredKeys.size > 0) out.requiredCustomMetadataKeys = [...requiredKeys];
  if (ownerMetadataKey !== undefined) out.ownerMetadataKey = ownerMetadataKey;
  return out;
}

export function isProbeableStorageSite(site: AccessSite): boolean {
  if (site.admin || site.service !== 'storage' || site.resolution === 'unresolved') return false;
  if (site.path.includes('=**')) return false;
  if (STORAGE_LIST_OPS.has(site.op) && site.path === '') return true;
  if (!site.path) return false;
  return parseResourcePattern('storage', site.path, site.resourceId).segments.some(
    (seg) => seg.kind === 'lit',
  );
}

export function dedupeStorageSites(sites: readonly AccessSite[]): AccessSite[] {
  const byKey = new Map<string, AccessSite>();
  for (const site of sites) {
    const pattern = parseResourcePattern('storage', site.path, site.resourceId);
    const uploadSig = `${site.storageUpload?.contentType ?? ''}:${String(site.storageUpload?.sizeBytes ?? '')}`;
    const fieldsSig = (site.payload?.fields ?? []).map((f) => f.name).sort().join(',');
    const key = `${resourceShapeKey(pattern)}|${site.op}|${uploadSig}|${fieldsSig}`;
    if (!byKey.has(key)) byKey.set(key, site);
  }
  return [...byKey.values()];
}

export function storageOpCategory(site: AccessSite): FindingOp {
  if (STORAGE_DELETE_OPS.has(site.op)) return 'delete';
  if (STORAGE_UPDATE_OPS.has(site.op)) return 'update';
  if (STORAGE_READ_OPS.has(site.op)) return 'read';
  return 'create';
}
