/**
 * Prompt building for the "Explain this denial" assist (read-only). Pure: takes
 * the captured denial + the deployed rules and produces a system + user prompt
 * the assist sends. No tools, no mutation, so it is the lowest-risk assist and
 * the one that validates the live inference path.
 */

export const RULES_EXPLAIN_SYSTEM =
  'You are a Firebase Security Rules expert helping a developer debug a denied ' +
  'operation in a local sandbox. In plain English and concisely (2 to 4 ' +
  'sentences), explain WHY this operation was denied based on the rule that ' +
  'matched and the request context, then say what would need to change for it to ' +
  'be allowed. Describe the fix in words; do not write the full ruleset. Be ' +
  'specific to the captured request.';

export interface DenialExplainInput {
  method: string;
  path: string;
  auth: { uid: string } | null;
  rulesSource: string;
  /** request.resource.data (the proposed write), if any. */
  requestData?: unknown;
  /** The existing document the rule saw, if any. */
  resourceData?: unknown;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Build the user prompt describing a denied op + the rules it ran against. */
export function buildDenialExplainPrompt(d: DenialExplainInput): string {
  const lines = [
    'A Firestore operation was DENIED by security rules.',
    `Operation: ${d.method} ${d.path}`,
    `request.auth: ${d.auth ? `signed in as ${d.auth.uid}` : 'null (unauthenticated)'}`,
  ];
  if (d.requestData !== undefined) lines.push(`request.resource.data: ${safeJson(d.requestData)}`);
  if (d.resourceData !== undefined) lines.push(`existing document (resource.data): ${safeJson(d.resourceData)}`);
  lines.push(
    '',
    'Deployed firestore.rules:',
    '```',
    d.rulesSource,
    '```',
    '',
    'Explain why this was denied and what would allow it.',
  );
  return lines.join('\n');
}
