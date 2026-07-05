import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Surface = 'auth' | 'firestore' | 'rtdb' | 'rtdb-modular' | 'storage';
export type Automation =
  | 'oracle-backed'
  | 'unit-backed'
  | 'type-backed'
  | 'sandbox-only'
  | 'playground-only'
  | 'unsupported'
  | 'unverified';

export interface MatrixRow {
  id: string;
  aliases: string[];
  matrix: Surface;
  rowRef: string;
  rowNumber: number | null;
  behavior: string;
  status: string;
  evidence: string;
  section: string;
  file: string;
  line: number;
}

export interface Observation {
  file: string;
  name: string;
  matrixRow: string;
  rowIds: string[];
  observedAt?: string;
  fbSdkVersion?: string;
  behavior: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface ConformanceCheck {
  finding: string;
  observation: string;
  expect: Record<string, unknown>;
  probe: string;
  guards: string;
}

export interface RegistryOverlay {
  version: number;
  conformanceChecks: ConformanceCheck[];
  rowOverrides?: Record<string, Partial<Pick<RegistryEntry, 'automation' | 'risk' | 'riskScore' | 'riskReasons' | 'exceptionReason' | 'notes'>>>;
  observationExceptions?: Record<string, string>;
}

export interface RegistryEntry extends MatrixRow {
  risk: string[];
  riskScore: number;
  riskReasons: string[];
  automation: Automation;
  oracleObservations: string[];
  conformanceTests: string[];
  exceptionReason?: string;
  notes?: string;
  hasOracle: boolean;
  hasTestEvidence: boolean;
  isConforming: boolean;
}

export interface CompatibilityLedger {
  rows: MatrixRow[];
  entries: RegistryEntry[];
  observations: Observation[];
  overlay: RegistryOverlay;
  orphanObservations: Observation[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const REGISTRY_PATH = join(HERE, 'registry.json');
export const OBS_DIR = join(REPO_ROOT, 'scripts', 'oracle', 'observations');

const COMPAT_FILES: Array<{ matrix: Surface; file: string }> = [
  { matrix: 'auth', file: join(REPO_ROOT, 'packages', 'pyric', 'docs', 'auth', 'COMPAT.md') },
  { matrix: 'firestore', file: join(REPO_ROOT, 'packages', 'pyric', 'docs', 'firestore', 'COMPAT.md') },
  { matrix: 'rtdb', file: join(REPO_ROOT, 'packages', 'pyric', 'docs', 'database', 'COMPAT.md') },
  { matrix: 'storage', file: join(REPO_ROOT, 'packages', 'pyric', 'docs', 'storage', 'COMPAT.md') },
];

export function repoRel(path: string): string {
  return relative(REPO_ROOT, path).replace(/\\/g, '/');
}

export function splitMarkdownRow(line: string): string[] {
  let body = line.trim();
  if (!body.startsWith('|')) return [];
  body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);

  const cells: string[] = [];
  let cell = '';
  let inCode = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    const next = body[i + 1];
    if (ch === '\\' && next === '|') {
      cell += '|';
      i++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function rowRefFromCell(cell: string): string | null {
  const row = cell.trim();
  if (/^-+$/.test(row) || row === '#') return null;
  if (!/^(?:M)?\d+[a-z]?$/i.test(row)) return null;
  return row;
}

function rowNumber(rowRef: string): number | null {
  const m = /\d+/.exec(rowRef);
  return m ? Number(m[0]) : null;
}

function surfaceForRow(base: Surface, rowRef: string, section: string): Surface {
  if (base !== 'rtdb') return base;
  if (/^M\d+/i.test(rowRef)) return 'rtdb-modular';
  if (/modular sdk surface/i.test(section)) return 'rtdb-modular';
  return 'rtdb';
}

function makeId(surface: Surface, rowRef: string): string {
  return `${surface}#${rowRef}`;
}

function aliasesFor(surface: Surface, rowRef: string): string[] {
  const out: string[] = [];
  if (surface === 'rtdb-modular' && /^\d+[a-z]?$/i.test(rowRef)) out.push(`rtdb#${rowRef}`);
  return out;
}

export function parseCompatFile(file: string, baseMatrix: Surface): MatrixRow[] {
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const rows: MatrixRow[] = [];
  let section = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sectionMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    if (!line.trim().startsWith('|')) continue;
    const cells = splitMarkdownRow(line);
    if (cells.length < 4) continue;
    const rowRef = rowRefFromCell(cells[0]!);
    if (!rowRef) continue;
    const matrix = surfaceForRow(baseMatrix, rowRef, section);
    rows.push({
      id: makeId(matrix, rowRef),
      aliases: aliasesFor(matrix, rowRef),
      matrix,
      rowRef,
      rowNumber: rowNumber(rowRef),
      behavior: cells[1] ?? '',
      status: cells[2] ?? '',
      evidence: cells.slice(3).join(' | '),
      section,
      file: repoRel(file),
      line: i + 1,
    });
  }
  return rows;
}

export function parseAllCompatRows(): MatrixRow[] {
  return COMPAT_FILES.flatMap(({ matrix, file }) => parseCompatFile(file, matrix));
}

export function parseObservationRowIds(matrixRow: string): string[] {
  const m = /^([a-z-]+)\s+#(.+)$/i.exec(matrixRow.trim());
  if (!m) return [];
  const surface = m[1]!.toLowerCase() as Surface;
  const rest = m[2]!.replace(/\(.+?\)/g, ' ');
  const refs = [...rest.matchAll(/#?((?:M)?\d+[a-z]?)/gi)].map((x) => x[1]!);
  return refs.map((ref) => makeId(surface, ref));
}

export function loadObservations(): Observation[] {
  return readdirSync(OBS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8')) as Record<string, unknown>;
      const name = String(raw.name ?? file.replace(/\.json$/, ''));
      const matrixRow = String(raw.matrixRow ?? '');
      return {
        file,
        name,
        matrixRow,
        rowIds: parseObservationRowIds(matrixRow),
        observedAt: typeof raw.observedAt === 'string' ? raw.observedAt : undefined,
        fbSdkVersion: typeof raw.fbSdkVersion === 'string' ? raw.fbSdkVersion : undefined,
        behavior: (raw.behavior && typeof raw.behavior === 'object' ? raw.behavior : {}) as Record<string, unknown>,
        raw,
      } satisfies Observation;
    });
}

export function loadRegistryOverlay(): RegistryOverlay {
  if (!existsSync(REGISTRY_PATH)) {
    return { version: 1, conformanceChecks: [], rowOverrides: {}, observationExceptions: {} };
  }
  const overlay = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as RegistryOverlay;
  overlay.conformanceChecks ??= [];
  overlay.rowOverrides ??= {};
  overlay.observationExceptions ??= {};
  return overlay;
}

function citedObservationNames(evidence: string): string[] {
  return [...evidence.matchAll(/scripts\/oracle\/observations\/([A-Za-z0-9_.-]+)\.json/g)].map((m) => m[1]!);
}

function conformanceTestRefs(evidence: string): string[] {
  const refs = new Set<string>();
  for (const m of evidence.matchAll(/(?:unit|playground|fixture):([A-Za-z0-9_./-]+(?:\.test\.ts)?)/g)) refs.add(m[0]!);
  for (const m of evidence.matchAll(/(?:^|[\s`(])((?:packages|test|unit|scripts)\/[A-Za-z0-9_./-]+\.test\.ts)/g)) refs.add(m[1]!);
  if (/type-only smoke|type-check|typecheck/i.test(evidence)) refs.add('typecheck');
  return [...refs].sort();
}

function hasTestEvidence(evidence: string): boolean {
  return /\bunit:|\bplayground:|\bfixture:|\.test\.ts\b|type-only smoke|type-check|typecheck/i.test(evidence);
}

function skipReason(row: MatrixRow): { automation?: Automation; reason?: string } {
  const text = `${row.section}\n${row.behavior}\n${row.evidence}`;
  if (/\bsandbox\.\*|sandbox-only|sandbox driver|sandbox-only test driver/i.test(row.section) ||
      /\b(no-mock-configured|sandbox-live|sandbox-only|mockSignInResult|mock['']s)\b|\bon prod-backed handles?\b/i.test(text)) {
    return { automation: 'sandbox-only', reason: 'sandbox-only behavior — no prod equivalent to observe' };
  }
  if (/\b(preview tree|AppPreview|preview-tree|playground)\b/i.test(text) || /\bpreview\b.*\bmount/i.test(text)) {
    return { automation: 'playground-only', reason: 'playground / preview behavior — no firebase-js-sdk counterpart to observe' };
  }
  if (/\b(re-?exported?|re-?exports?|Exports? the same|Constructors? are re-?exported)\b/i.test(row.behavior) ||
      /\ball\s+\d+\s+ops\b/i.test(row.behavior) || /type-only smoke|type-check|typecheck/i.test(row.evidence)) {
    return { automation: 'type-backed', reason: 'structural / type shape — verified without a prod observation' };
  }
  return {};
}

function riskFor(row: MatrixRow): { risk: string[]; riskScore: number; riskReasons: string[] } {
  const risk = new Set<string>();
  const reasons: string[] = [];
  let score = 0;
  const text = `${row.behavior} ${row.evidence}`;

  const backtickedValues = text.match(/`([a-z][\w-]*\/[\w-]+|[a-z]+-[\w-]+|'[^']+')`/gi) ?? [];
  if (backtickedValues.length > 0) {
    score += 2;
    risk.add('specific-value');
    reasons.push(`asserts ${backtickedValues.length} specific value(s)`);
  }
  const codes = text.match(/`(auth|firestore|app|permission|storage)\/[a-z-]+`|`(not-found|already-exists|permission-denied|invalid-argument|failed-precondition|aborted|object-not-found)`/g) ?? [];
  if (codes.length > 0) {
    score += 3;
    risk.add('error-code');
    reasons.push(`asserts Firebase error code(s): ${codes.slice(0, 4).join(', ')}`);
  }
  if (/exactly\s+(\d+|one|once|twice|two|three|four|five)\s+(fire|time|fires|times)|fires\s+(exactly|once|twice|N|\d)|\d+\s+(fire|time)s?\s+per/i.test(text)) {
    score += 2;
    risk.add('listener-fire-count');
    reasons.push('asserts a specific listener fire count');
  }
  if (/===\s*['"]?[\w-]+['"]?|`\w+:\s*['"]?[\w-]+['"]?`/.test(text)) {
    score += 1;
    risk.add('specific-field');
    reasons.push('asserts a specific field/property value');
  }
  if (/\b(fire|fires|fired|double-?fire)\b|\bobserver?\b|\b(?:un)?subscribe\b|onAuthStateChanged|onSnapshot|onIdTokenChanged|\blistener/i.test(text)) {
    score += 2;
    risk.add('listener');
    reasons.push('asserts listener semantics');
  }
  if (/\b(synchronously|asynchronously|immediately|microtask-?deferred|on next tick|deferred until|after a microtask)\b/i.test(text)) {
    score += 2;
    risk.add('timing');
    reasons.push('asserts timing semantics');
  }
  if (/\b(inclusive|exclusive)\b\s*(of|--)?|\bstart\s+(at|after)\b|\bend\s+(at|before)\b/i.test(text)) {
    score += 2;
    risk.add('cursor-inclusivity');
    reasons.push('asserts cursor/boundary semantics');
  }
  if (/\b(atomically|de-?dupes?|resolves to a Timestamp|strips? matching|removes? matching)\b|\b(serverTimestamp|increment|arrayUnion|arrayRemove|deleteField)\b/i.test(text)) {
    score += 2;
    risk.add('sentinel');
    reasons.push('asserts sentinel or atomic transform semantics');
  }
  if (/\b(or\(\)|and\(\)|composite\s+(filter|tree)|sub-?filter)\b/i.test(text)) {
    score += 2;
    risk.add('composite-filter');
    reasons.push('asserts composite filter semantics');
  }
  if (/transaction|batch|atomic/i.test(text)) {
    score += 2;
    risk.add('atomicity');
    reasons.push('asserts transaction/batch atomicity');
  }
  if (/rules?-denied|permission|unauthorized|security rules/i.test(text)) {
    score += 2;
    risk.add('rules-denial');
    reasons.push('asserts rules-denial behavior');
  }
  if (/metadata|contentType|metageneration|md5Hash/i.test(text)) {
    score += 1;
    risk.add('metadata');
    reasons.push('asserts metadata shape');
  }

  if (/returns? a tagged|brand|TARGET_SYMBOL|WeakMap|routes? (through|via)/i.test(row.behavior) && score === 0) {
    risk.add('structural');
    reasons.push('structural / routing-only claim');
  }

  return { risk: [...risk], riskScore: score, riskReasons: reasons };
}

function automationFor(row: MatrixRow, hasOracle: boolean, testEvidence: boolean, skip: ReturnType<typeof skipReason>): { automation: Automation; exceptionReason?: string } {
  if (skip.automation) return { automation: skip.automation, exceptionReason: skip.reason };
  if (hasOracle) return { automation: 'oracle-backed' };
  if (testEvidence) return { automation: 'unit-backed' };
  if (/—|not implemented|deny-list|out of scope/i.test(row.status) || /not implemented|deny-list|out of scope/i.test(row.evidence)) {
    return { automation: 'unsupported', exceptionReason: 'unsupported / intentionally out of scope' };
  }
  return { automation: 'unverified' };
}

export function buildCompatibilityLedger(): CompatibilityLedger {
  const overlay = loadRegistryOverlay();
  const rows = parseAllCompatRows();
  const observations = loadObservations();
  const rowLookup = new Map<string, MatrixRow>();
  for (const row of rows) {
    rowLookup.set(row.id, row);
    for (const alias of row.aliases) rowLookup.set(alias, row);
  }

  const observationsByRow = new Map<string, string[]>();
  for (const obs of observations) {
    for (const id of obs.rowIds) {
      const row = rowLookup.get(id);
      const key = row?.id ?? id;
      const list = observationsByRow.get(key) ?? [];
      list.push(obs.name);
      observationsByRow.set(key, list);
    }
  }

  const entries = rows.map((row) => {
    const oracleObservations = [...new Set([...(observationsByRow.get(row.id) ?? []), ...citedObservationNames(row.evidence)])].sort();
    const testRefs = conformanceTestRefs(row.evidence);
    const testEvidence = hasTestEvidence(row.evidence);
    const skip = skipReason(row);
    const risk = riskFor(row);
    const automation = automationFor(row, oracleObservations.length > 0, testEvidence, skip);
    const override = overlay.rowOverrides?.[row.id] ?? {};
    return {
      ...row,
      ...risk,
      ...automation,
      oracleObservations,
      conformanceTests: testRefs,
      hasOracle: oracleObservations.length > 0,
      hasTestEvidence: testEvidence,
      isConforming: row.status.includes('✓'),
      ...override,
    } satisfies RegistryEntry;
  });

  const allRowIds = new Set<string>();
  for (const row of rows) {
    allRowIds.add(row.id);
    for (const alias of row.aliases) allRowIds.add(alias);
  }
  const exceptions = overlay.observationExceptions ?? {};
  const orphanObservations = observations.filter((obs) => {
    if (exceptions[obs.name]) return false;
    return obs.rowIds.length === 0 || obs.rowIds.every((id) => !allRowIds.has(id));
  });

  return { rows, entries, observations, overlay, orphanObservations };
}

export function summarizeLedger(ledger: CompatibilityLedger) {
  const entries = ledger.entries;
  const bySurface = Object.fromEntries(
    (['auth', 'firestore', 'rtdb', 'rtdb-modular', 'storage'] as Surface[]).map((surface) => [surface, entries.filter((e) => e.matrix === surface).length]),
  ) as Record<Surface, number>;
  const explicitExceptions = entries.filter((e) => ['sandbox-only', 'playground-only', 'type-backed', 'unsupported'].includes(e.automation));
  const highRiskUnverified = entries.filter((e) => e.isConforming && e.riskScore >= 2 && e.automation === 'unverified');
  return {
    totalRows: entries.length,
    bySurface,
    conformingRows: entries.filter((e) => e.isConforming).length,
    oracleBackedRows: entries.filter((e) => e.hasOracle).length,
    unitBackedRows: entries.filter((e) => e.automation === 'unit-backed').length,
    explicitExceptionRows: explicitExceptions.length,
    unsupportedRows: entries.filter((e) => e.automation === 'unsupported').length,
    unverifiedRows: entries.filter((e) => e.automation === 'unverified').length,
    highRiskUnverifiedRows: highRiskUnverified.length,
    observations: ledger.observations.length,
    orphanObservations: ledger.orphanObservations.length,
    conformanceChecks: ledger.overlay.conformanceChecks.length,
  };
}
