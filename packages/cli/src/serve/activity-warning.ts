import type { ActivityIncident } from 'pyric/firestore/internal';

function decodeIncidentTarget(rawTarget: string): string {
  if (!rawTarget.startsWith('{')) {
    return rawTarget;
  }
  try {
    const parsed: unknown = JSON.parse(rawTarget);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return rawTarget;
    }
    const record = parsed as Record<string, unknown>;
    if (record.kind === 'doc' && typeof record.path === 'string' && record.path.length > 0) {
      return record.path;
    }
    if (record.kind === 'query' && typeof record.collection === 'string' && record.collection.length > 0) {
      if (typeof record.query === 'string' && record.query.length > 0) {
        return `${record.collection} (query ${record.query})`;
      }
      return `${record.collection} (query)`;
    }
  } catch {
    /* Non-JSON or truncated fingerprints stay verbatim after terminal sanitization. */
  }
  return rawTarget;
}

function describeActivityPattern(incident: ActivityIncident): string {
  if (incident.pattern === 'repeated-read') {
    return `${incident.count} repeated Firestore ${incident.method} operations`;
  }
  let lowerBoundPrefix = '';
  if (incident.listenerBalance?.isLowerBound === true) {
    lowerBoundPrefix = 'at least ';
  }
  if (incident.pattern === 'duplicate-listener') {
    return `${lowerBoundPrefix}${incident.count} duplicate active Firestore listeners`;
  }
  const balance = incident.listenerBalance;
  const attaches = balance ? balance.attaches : incident.count;
  const detaches = balance ? balance.detaches : 0;
  const active = balance ? balance.active : 0;
  return `${lowerBoundPrefix}${attaches} Firestore listener attaches, `
    + `${detaches} detaches, `
    + `${active} still active (listener churn)`;
}

function describeActivityCause(incident: ActivityIncident): string {
  if (incident.pattern === 'duplicate-listener') {
    return 'Possible causes include multiple components attaching independent onSnapshot '
      + 'listeners without sharing a subscription or missing listener cleanup.';
  }
  if (incident.pattern === 'listener-churn') {
    return 'Possible causes include unstable effect dependencies re-subscribing onSnapshot '
      + 'on every render or rapid mount/unmount cycles.';
  }
  return 'Possible causes include repeated render/effect execution or missing listener cleanup.';
}

function describeUsageUnit(incident: ActivityIncident): string {
  if (incident.usage.unit === 'document-reads') {
    return 'document reads';
  }
  return 'listener attachments';
}

/** Format a terminal-safe, warning-only summary of observed Firebase activity. */
export function formatActivityWarning(incident: ActivityIncident): string {
  const target = terminalSafe(decodeIncidentTarget(incident.targetFingerprint));
  const activity = describeActivityPattern(incident);
  const unit = describeUsageUnit(incident);
  const source = terminalSafe(incident.sourceAttribution);
  const cause = describeActivityCause(incident);
  return `  \u26a0 Firebase Activity Guard: ${activity} on ${target} in ${incident.windowMs}ms. `
    + `Observed lower bound: ${incident.usage.lowerBound} ${unit}. `
    + `Source: ${source}. ${cause} (warning only; app behavior is unchanged)`;
}

function terminalSafe(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
    '',
  );
}
