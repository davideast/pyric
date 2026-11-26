/**
 * Pure, browser-safe wire contract for compact, credential-free deployed
 * Security Rules evaluation summaries attached to observed Live-mode denial
 * events (`event.detail.deployedRules`, `#2363`).
 *
 * Contains zero Node built-in imports so browser chip bundles
 * (`chip-traffic.ts`, `chip-rules-evidence.ts`) can import it safely.
 */

export interface DeployedRulesEventRule {
  readonly path?: string;
  readonly line?: number;
  readonly expression?: string;
}

export interface DeployedRulesEventDrift {
  readonly status: 'match' | 'drifted' | 'no-local-rules';
  readonly drifted: boolean;
  readonly firstDiffLine?: number;
  readonly rtdbChangeCount?: number;
  readonly summary: string;
}

export interface DeployedRulesEventDetail {
  readonly source: 'deployed' | 'local';
  readonly service?: 'firestore' | 'rtdb' | 'storage';
  readonly target?: string;
  readonly verdict?: 'allow' | 'deny' | 'unevaluated';
  readonly productionDisagrees?: boolean;
  readonly rule?: DeployedRulesEventRule;
  readonly needs?: readonly string[];
  readonly drift?: DeployedRulesEventDrift;
  readonly releaseName?: string;
  readonly rulesetId?: string;
  readonly deployedHash?: string;
  readonly fallbackReason?: string;
  readonly fallbackMessage?: string;
}

interface MutableEventDetail {
  source: 'deployed' | 'local';
  service?: 'firestore' | 'rtdb' | 'storage';
  target?: string;
  verdict?: 'allow' | 'deny' | 'unevaluated';
  productionDisagrees?: boolean;
  rule?: DeployedRulesEventRule;
  needs?: readonly string[];
  drift?: DeployedRulesEventDrift;
  releaseName?: string;
  rulesetId?: string;
  deployedHash?: string;
  fallbackReason?: string;
  fallbackMessage?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function readRule(raw: unknown): DeployedRulesEventRule | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: { path?: string; line?: number; expression?: string } = {};
  if (typeof raw.path === 'string') out.path = raw.path;
  if (typeof raw.line === 'number' && Number.isFinite(raw.line)) out.line = raw.line;
  if (typeof raw.expression === 'string') out.expression = raw.expression;
  if (out.path === undefined && out.line === undefined && out.expression === undefined) {
    return undefined;
  }
  return out;
}

function readDrift(raw: unknown): DeployedRulesEventDrift | undefined {
  if (!isPlainObject(raw)) return undefined;
  const status = raw.status;
  const validStatus =
    status === 'match' ||
    status === 'drifted' ||
    status === 'no-local-rules';
  if (!validStatus || typeof raw.drifted !== 'boolean' || typeof raw.summary !== 'string') {
    return undefined;
  }
  const out: {
    status: DeployedRulesEventDrift['status'];
    drifted: boolean;
    firstDiffLine?: number;
    rtdbChangeCount?: number;
    summary: string;
  } = {
    status,
    drifted: raw.drifted,
    summary: raw.summary,
  };
  if (typeof raw.firstDiffLine === 'number' && Number.isFinite(raw.firstDiffLine)) {
    out.firstDiffLine = raw.firstDiffLine;
  }
  if (typeof raw.rtdbChangeCount === 'number' && Number.isFinite(raw.rtdbChangeCount)) {
    out.rtdbChangeCount = raw.rtdbChangeCount;
  }
  return out;
}

/**
 * Validates and clones `event.detail.deployedRules` into a strictly typed
 * summary, returning `undefined` when absent or malformed.
 */
export function readDeployedRulesEventDetail(raw: unknown): DeployedRulesEventDetail | undefined {
  if (!isPlainObject(raw)) return undefined;
  const source = raw.source;
  if (source !== 'deployed' && source !== 'local') return undefined;
  const out: MutableEventDetail = { source };
  if (raw.service === 'firestore' || raw.service === 'rtdb' || raw.service === 'storage') {
    out.service = raw.service;
  }
  if (typeof raw.target === 'string') out.target = raw.target;
  if (raw.verdict === 'allow' || raw.verdict === 'deny' || raw.verdict === 'unevaluated') {
    out.verdict = raw.verdict;
  }
  if (typeof raw.productionDisagrees === 'boolean') {
    out.productionDisagrees = raw.productionDisagrees;
  }
  const rule = readRule(raw.rule);
  if (rule !== undefined) out.rule = rule;
  if (Array.isArray(raw.needs)) {
    const needs = raw.needs.filter((entry): entry is string => typeof entry === 'string');
    if (needs.length > 0) out.needs = needs;
  }
  const drift = readDrift(raw.drift);
  if (drift !== undefined) out.drift = drift;
  if (typeof raw.releaseName === 'string') out.releaseName = raw.releaseName;
  if (typeof raw.rulesetId === 'string') out.rulesetId = raw.rulesetId;
  if (typeof raw.deployedHash === 'string') out.deployedHash = raw.deployedHash;
  if (typeof raw.fallbackReason === 'string') out.fallbackReason = raw.fallbackReason;
  if (typeof raw.fallbackMessage === 'string') out.fallbackMessage = raw.fallbackMessage;
  return out;
}
