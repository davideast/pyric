/**
 * A builder's brief: what one builder run builds and attempts. The brief
 * writer (Opus 5.5) writes one JSON file per brief into
 * `<data dir>/briefs/<round>/`; `round` validates every one before it starts
 * anything, and gives each builder the brief as text (`renderBrief`).
 *
 * The model and the dollar cap are not in the brief: each brief runs once per
 * model, at the cap `round` is given, so the comparison is per brief.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJsonText, parseWith, type Parsed } from './parse.ts';

export const STRESS_DIMENSIONS = ['scale', 'lifecycle', 'integration', 'combination', 'concurrency'] as const;
export const FRAMEWORKS = ['next-16', 'vite', 'node-server'] as const;
export type Framework = (typeof FRAMEWORKS)[number];

/** How each framework reads in the text a builder gets. */
const FRAMEWORK_LABELS: Record<Framework, string> = {
  'next-16': 'Next 16',
  vite: 'Vite',
  'node-server': 'Node server (node --import @pyric/cli/register)',
};

/** A page of Firebase's own documentation: the only source a must-be-refused line may cite. */
function isFirebaseDoc(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname === 'firebase.google.com';
  } catch {
    return false;
  }
}

const text = z.string().trim().min(1);

const refusal = z.object({
  action: text,
  firebaseDoc: z.string().refine(isFirebaseDoc, 'must be an https://firebase.google.com/ page'),
  productionAnswer: text,
}).strict();

const isDistinct = (values: readonly string[]) => new Set(values).size === values.length;

export const briefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*-\d+$/, 'must be <round>-<n>'),
  targetArea: z.object({ area: text, whyWeak: text }).strict(),
  stressDimensions: z.array(z.enum(STRESS_DIMENSIONS)).min(1).max(2).refine(isDistinct, 'must not repeat a dimension'),
  appIdea: text,
  framework: z.enum(FRAMEWORKS),
  features: z.array(text).min(1),
  userJourney: z.array(text).min(1),
  mustBeRefused: z.array(refusal).min(2).max(5),
  limits: z.object({ wallClockMinutes: z.number().int().positive().max(240) }).strict(),
}).strict();

export type Brief = z.infer<typeof briefSchema>;

export function parseBrief(value: unknown): Parsed<Brief> {
  return parseWith(briefSchema, value);
}

function readBriefFile(path: string): Parsed<Brief> {
  const json = parseJsonText(readFileSync(path, 'utf8'));
  return json.ok ? parseBrief(json.value) : json;
}

/** The command that makes a round's briefs directory under the data root. */
export const briefsSetupCommand = (dir: string) => `mkdir -p ${dir}`;

/** The briefs in `dir`, or, when there is no such directory, the command that makes it. */
export function readBriefsDir(dir: string): { briefs: Brief[]; errors: string[] } {
  if (existsSync(dir)) return readBriefs(dir);
  return { briefs: [], errors: [`no briefs directory ${dir}: make it with \`${briefsSetupCommand(dir)}\` and write the round's briefs there`] };
}

/** Every `*.json` brief in `dir`, sorted by name, or each file's errors. */
export function readBriefs(dir: string): { briefs: Brief[]; errors: string[] } {
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  const briefs: Brief[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const parsed = readBriefFile(join(dir, file));
    if (parsed.ok) briefs.push(parsed.value);
    else errors.push(...parsed.errors.map((error) => `${file}: ${error}`));
  }
  if (files.length === 0) errors.push(`no *.json briefs in ${dir}`);
  const ids = briefs.map((brief) => brief.id);
  if (!isDistinct(ids)) errors.push(`two briefs share an id: ${ids.join(', ')}`);
  return { briefs, errors };
}

const indent = (lines: readonly string[]) => lines.map((line) => `                    - ${line}`).join('\n');

/** The brief as the builder reads it, in the template's layout. */
export function renderBrief(brief: Brief, limits: { model: string; maxBudgetUsd: number }): string {
  const refusals = brief.mustBeRefused.map((line) => `${line.action} (${line.firebaseDoc}): ${line.productionAnswer}`);
  return [
    `Brief ${brief.id}`,
    `Target area:        ${brief.targetArea.area}`,
    `                    ${brief.targetArea.whyWeak}`,
    `Stress dimensions:  ${brief.stressDimensions.join(', ')}`,
    `App idea:           ${brief.appIdea}`,
    `Framework:          ${FRAMEWORK_LABELS[brief.framework]}`,
    'Features to use:',
    indent(brief.features),
    'User journey:',
    indent(brief.userJourney.map((step, index) => `${index + 1}. ${step}`)),
    'Must be refused:    each line: the action, the Firebase doc, production\'s answer',
    indent(refusals),
    `Limits:             ${limits.model}, $${limits.maxBudgetUsd}, ${brief.limits.wallClockMinutes} minutes`,
    '',
  ].join('\n');
}
