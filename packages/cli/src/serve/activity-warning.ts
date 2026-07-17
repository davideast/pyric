import type { ActivityIncident } from 'pyric/firestore/internal';

/** Format a terminal-safe, warning-only summary of observed Firebase activity. */
export function formatActivityWarning(incident: ActivityIncident): string {
  const target = terminalSafe(incident.targetFingerprint);
  const lowerBound = incident.listenerBalance?.isLowerBound === true ? 'at least ' : '';
  const activity = incident.pattern === 'repeated-read'
    ? `${incident.count} repeated Firestore ${incident.method} operations`
    : incident.pattern === 'duplicate-listener'
      ? `${lowerBound}${incident.count} duplicate active Firestore listeners`
      : `${lowerBound}${incident.listenerBalance!.attaches} Firestore listener attaches, `
        + `${incident.listenerBalance!.detaches} detaches, `
        + `${incident.listenerBalance!.active} still active (listener churn)`;
  const unit = incident.usage.unit === 'document-reads' ? 'document reads' : 'listener attachments';
  return `  ⚠ Firebase Activity Guard: ${activity} on ${target} in ${incident.windowMs}ms. `
    + `Observed lower bound: ${incident.usage.lowerBound} ${unit}. `
    + `Source: ${incident.sourceAttribution}. Possible causes include repeated render/effect `
    + 'execution or missing listener cleanup. (warning only; app behavior is unchanged)';
}

function terminalSafe(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
    '',
  );
}
