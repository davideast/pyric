/**
 * Denial-walkthrough model — pure functions behind the guided
 * `inspect_denial` drill-in. Two panels:
 *
 *   1. why this request failed                 — deterministic
 *   2. the fix pattern                         — LLM (explain.ts's
 *      denial prompt), plus a deterministic "Send to agent" prompt
 *
 * Panel 1 derives entirely from the tool result; no model call.
 * This module owns the parsing + the fix-prompt shape; the component
 * owns rendering and the streamed second panel.
 */
import type { DenialBlurb } from '~/lib/store/runtime';

/** Mirror of `inspectDenialHandler`'s success payload. */
export interface InspectDenialDenial {
  at?: number;
  op?: string;
  path?: string;
  method?: string;
  auth?: string;
  message?: string;
  classification?: 'expected' | 'ambiguous' | 'unexpected';
  classificationReason?: string;
}

export interface InspectDenialData {
  denial?: InspectDenialDenial;
  /** Failure payloads (`ok: false`). */
  reason?: 'no_denials' | 'path_not_found';
  knownPaths?: string[];
}

/** Parse the tool's resultJson defensively — malformed/absent JSON
 *  returns null and the component falls back to the generic view. */
export function parseInspectDenialResult(resultJson: string | undefined): InspectDenialData | null {
  if (!resultJson) return null;
  try {
    const v = JSON.parse(resultJson) as unknown;
    return v && typeof v === 'object' ? (v as InspectDenialData) : null;
  } catch {
    return null;
  }
}

/** Panel-1 model: labeled facts, in reading order. */
export interface WhyRow {
  label: string;
  value: string;
  /** Visual emphasis for the classification row. */
  tone?: 'expected' | 'ambiguous' | 'unexpected';
}

export function buildWhyRows(denial: InspectDenialDenial): WhyRow[] {
  const rows: WhyRow[] = [];
  const op = [denial.method, denial.path].filter(Boolean).join(' ') || denial.op;
  if (op) rows.push({ label: 'request', value: op });
  rows.push({ label: 'auth', value: denial.auth || '(unknown)' });
  if (denial.message) rows.push({ label: 'simulator said', value: denial.message });
  if (denial.classification) {
    rows.push({
      label: 'classification',
      value: denial.classificationReason
        ? `${denial.classification} — ${denial.classificationReason}`
        : denial.classification,
      tone: denial.classification,
    });
  }
  return rows;
}

/**
 * Deterministic, well-shaped fix prompt for "Send to agent". Carries
 * the evidence (denial facts) and a BOUNDED instruction: diagnose
 * rule-vs-app-vs-intended first, change the minimum, and explicitly
 * allow "this is the rule working — change nothing" so the agent
 * isn't railroaded into loosening rules.
 */
export function buildFixPrompt(data: InspectDenialData): string {
  const d = data.denial ?? {};
  const lines: string[] = [];
  lines.push('A Firestore request was denied. Investigate it and fix the root cause.');
  lines.push('');
  lines.push('Denial:');
  const op = [d.method, d.path].filter(Boolean).join(' ') || d.op || '(unknown op)';
  lines.push(`- request: ${op}`);
  lines.push(`- auth: ${d.auth ?? '(unknown)'}`);
  if (d.message) lines.push(`- simulator message: ${d.message}`);
  if (d.classification) {
    lines.push(
      `- classification: ${d.classification}${d.classificationReason ? ` (${d.classificationReason})` : ''}`,
    );
  }
  lines.push('');
  lines.push(
    'Read /workspace/firestore.rules to see the CURRENT editor rules (sandbox denials evaluate against the editor body, not production). Then decide which case this is:',
  );
  lines.push('(a) the rule is working as intended — explain why and change NOTHING;');
  lines.push(
    '(b) the rules are wrong — make the MINIMAL edit to /workspace/firestore.rules that allows this request without opening unrelated access;',
  );
  lines.push(
    '(c) the app code is wrong — fix the app so it stops issuing a request the rules correctly reject.',
  );
  lines.push('State which case you picked and why before making any edit.');
  return lines.join('\n');
}

/**
 * Recover the full `DenialBlurb` for explain.ts's denial prompt.
 * Prefer the live runtime-store entry (it carries the canonical
 * request envelope with resource data); synthesize a minimal blurb
 * from the tool result when the store no longer has it (restored
 * session, ring buffer rolled).
 */
export function toDenialBlurb(
  data: InspectDenialData,
  liveDenials: readonly DenialBlurb[],
): DenialBlurb {
  const d = data.denial ?? {};
  const live = liveDenials.find((b) => b.at === d.at && (!d.op || b.op === d.op));
  if (live) return live;
  return {
    id: `synth-${d.at ?? 0}`,
    at: d.at ?? 0,
    op: d.op ?? '(unknown)',
    auth: d.auth ?? '(unknown)',
    message: d.message ?? '',
    request: { request: { method: d.method, path: d.path } },
    classification: d.classification ?? 'ambiguous',
    classificationReason: d.classificationReason ?? 'reconstructed from tool result',
  };
}
