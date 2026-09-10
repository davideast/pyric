import type { ReplayDivergence, DivergenceSummaryData } from './replayTypes.js';
import type { FieldChange } from './components/ProposedChangeDiff.js';

export function computeDivergenceSummary(
  divergences: readonly ReplayDivergence[],
): DivergenceSummaryData {
  let realCount = 0;
  let sentinelDriftCount = 0;
  let timeDriftCount = 0;
  let autoidAliasCount = 0;
  let nowDeniedCount = 0;
  let otherCount = 0;

  for (const d of divergences) {
    switch (d.kind) {
      case 'real-divergence':
        realCount++;
        break;
      case 'sentinel-drift':
        sentinelDriftCount++;
        break;
      case 'time-drift':
        timeDriftCount++;
        break;
      case 'autoid-alias':
        autoidAliasCount++;
        break;
      case 'now-denied':
        nowDeniedCount++;
        break;
      default:
        otherCount++;
        break;
    }
  }

  return {
    total: divergences.length,
    realCount,
    sentinelDriftCount,
    timeDriftCount,
    autoidAliasCount,
    nowDeniedCount,
    otherCount,
  };
}

/**
 * Adapts classified `ReplayDivergence[]` into `FieldChange[]` rows suitable for
 * `ProposedChangeDiff`.
 */
export function divergencesToFieldChanges(
  divergences: readonly ReplayDivergence[],
): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const div of divergences) {
    switch (div.kind) {
      case 'real-divergence': {
        const kind =
          div.before === undefined
            ? 'added'
            : div.after === undefined
              ? 'removed'
              : 'changed';
        changes.push({
          docPath: div.path,
          field: div.field ?? '(document)',
          before: div.before,
          after: div.after,
          kind,
        });
        break;
      }
      case 'sentinel-drift': {
        changes.push({
          docPath: div.path,
          field: div.field,
          before: div.before,
          after: div.after,
          kind: 'changed',
        });
        break;
      }
      case 'time-drift': {
        changes.push({
          docPath: div.path,
          field: div.field,
          before: div.before,
          after: div.after,
          kind: 'changed',
        });
        break;
      }
      case 'autoid-alias': {
        changes.push({
          docPath: div.originalPath,
          field: '(autoid-alias)',
          before: div.originalPath,
          after: div.replayedPath,
          kind: 'changed',
        });
        break;
      }
      case 'now-denied': {
        changes.push({
          docPath: div.path ?? '(rules)',
          field: div.method ? `(${div.method} now-denied)` : '(now-denied)',
          before: div.before ?? 'allowed',
          after: div.after ?? (div.reason ? `denied: ${div.reason}` : 'denied'),
          kind: 'changed',
        });
        break;
      }
      case 'state-drift': {
        changes.push({
          docPath: div.path ?? '(state)',
          field: '(state-drift)',
          before: div.before,
          after: div.after,
          kind: 'changed',
        });
        break;
      }
      default:
        break;
    }
  }

  return changes;
}
