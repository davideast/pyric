/**
 * Parse streamed LLM output into a validated SeedProposalV1.
 */
import { SeedProposalV1Schema, type SeedProposalV1 } from './schema';

export type ParseProposalResult =
  | { ok: true; proposal: SeedProposalV1 }
  | { ok: false; error: string };

/** Extract JSON from raw model text (fence-tolerant). */
export function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

export function parseSeedProposal(raw: string): ParseProposalResult {
  const jsonText = extractJsonText(raw);
  if (!jsonText) {
    return { ok: false, error: 'Model returned empty output.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return {
      ok: false,
      error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const result = SeedProposalV1Schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? issue.path.join('.') : 'root';
    return {
      ok: false,
      error: `Proposal shape invalid at ${path}: ${issue?.message ?? 'validation failed'}`,
    };
  }
  if (Object.keys(result.data.firestore).length === 0) {
    return { ok: false, error: 'Proposal must include at least one Firestore collection.' };
  }
  return { ok: true, proposal: result.data };
}
