/**
 * Pure deployed-vs-local Security Rules drift detection for Live mode (`#2363`).
 *
 * - Firestore & Storage: compares normalized text (CRLF -> LF, trimmed) and
 *   reports the first differing line alongside SHA-256 short hashes.
 * - Realtime Database: parses local JSONC rules via `parseRtdbRulesText` and
 *   computes semantic rule diffs via `diffRtdbRules`, ignoring comments,
 *   formatting, and key ordering.
 */
import { diffRtdbRules, type RtdbRuleChange } from 'pyric/rules/internal/rtdb';
import { parseRtdbRulesText } from '../../rtdb/rules-json.js';
import { rulesHashOf } from '../rules.js';

export type RulesDriftStatus = 'match' | 'drifted' | 'no-local-rules';

export interface RulesDriftReport {
  readonly status: RulesDriftStatus;
  readonly drifted: boolean;
  readonly deployedHash: string;
  readonly localHash?: string;
  readonly firstDiffLine?: number;
  readonly rtdbChanges?: readonly RtdbRuleChange[];
  readonly summary: string;
}

function normalizeRulesText(source: string): string {
  return source.replace(/\r\n/g, '\n').trim();
}

function findFirstDiffLine(first: string, second: string): number {
  const firstLines = first.split('\n');
  const secondLines = second.split('\n');
  const maxLen = Math.max(firstLines.length, secondLines.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (firstLines[i] !== secondLines[i]) {
      return i + 1;
    }
  }
  return 1;
}

/**
 * Compares deployed Firestore or Storage rules text against the local rules file.
 * Normalizes CRLF line endings and leading/trailing whitespace to avoid false drift.
 */
export function compareTextRulesDrift(
  deployedSource: string,
  localSource: string | null | undefined,
  serviceLabel: string,
): RulesDriftReport {
  const normalizedDeployed = normalizeRulesText(deployedSource);
  const deployedHash = rulesHashOf(normalizedDeployed);
  if (localSource === null || localSource === undefined) {
    return {
      status: 'no-local-rules',
      drifted: false,
      deployedHash,
      summary: `No local ${serviceLabel} rules file loaded to compare against deployed rules.`,
    };
  }
  const normalizedLocal = normalizeRulesText(localSource);
  const localHash = rulesHashOf(normalizedLocal);
  if (normalizedDeployed === normalizedLocal) {
    return {
      status: 'match',
      drifted: false,
      deployedHash,
      localHash,
      summary: `Deployed ${serviceLabel} rules match the local rules file.`,
    };
  }
  const firstDiffLine = findFirstDiffLine(normalizedDeployed, normalizedLocal);
  return {
    status: 'drifted',
    drifted: true,
    deployedHash,
    localHash,
    firstDiffLine,
    summary: `Deployed ${serviceLabel} rules differ from the local rules file (first difference at line ${firstDiffLine}).`,
  };
}

/**
 * Compares deployed RTDB rules against the local `database.rules.json` using
 * `diffRtdbRules`, ignoring comments, key ordering, and whitespace.
 */
export function compareRtdbRulesDrift(
  deployedRules: Record<string, unknown>,
  deployedHash: string,
  localRulesText: string | null | undefined,
): RulesDriftReport {
  if (localRulesText === null || localRulesText === undefined) {
    return {
      status: 'no-local-rules',
      drifted: false,
      deployedHash,
      summary: 'No local Realtime Database rules file loaded to compare against deployed rules.',
    };
  }
  let local: { rules: Record<string, unknown> };
  try {
    local = parseRtdbRulesText(localRulesText, (reason) => reason);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: 'drifted',
      drifted: true,
      deployedHash,
      summary: `Local Realtime Database rules could not be parsed for drift comparison (${reason}).`,
    };
  }
  const localHash = rulesHashOf(JSON.stringify(local));
  const changes = diffRtdbRules(deployedRules, local.rules);
  if (changes.length === 0) {
    return {
      status: 'match',
      drifted: false,
      deployedHash,
      localHash,
      rtdbChanges: [],
      summary: 'Deployed Realtime Database rules match the local rules file.',
    };
  }
  return {
    status: 'drifted',
    drifted: true,
    deployedHash,
    localHash,
    rtdbChanges: changes,
    summary: `Deployed Realtime Database rules differ from the local rules file in ${changes.length} rule expression(s).`,
  };
}
