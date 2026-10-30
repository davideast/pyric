/**
 * What `reproduce` can re-run of a kept run: each problem in its
 * `report.json`, named the way the verifier names it on the command line.
 *
 * - a builder problem, by the id the builder gave it;
 * - `refusal-allowed-<n>`, the n-th must-be-refused action the builder
 *   reported pyric allowed;
 * - `google-host:<host>`, a Google host or the metadata address the run
 *   reached for.
 *
 * The builder wrote its own ids, so none is used as a path as written: each
 * target gets a slug of lowercase letters, digits and dashes, unique in the run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseJsonText, parseWith, type Parsed } from './parse.ts';
import { builderReportSchema, type BuilderReport } from './report.ts';

export type BuilderProblem = BuilderReport['problems'][number];

export type ReproTarget =
  | { kind: 'builder-problem'; selector: string; slug: string; problem: BuilderProblem }
  | { kind: 'refusal-allowed'; selector: string; slug: string; action: string; productionAnswer: string; pyricAnswer: string }
  | { kind: 'google-host'; selector: string; slug: string; host: string };

const refusalAllowed = z.object({ kind: z.literal('refusal-allowed'), action: z.string(), productionAnswer: z.string(), pyricAnswer: z.string() }).passthrough();
const googleHost = z.object({ kind: z.literal('google-host'), host: z.string() }).passthrough();

/** The parts of a kept `report.json` that `reproduce` reads. */
const keptRunSchema = z.object({
  builder: builderReportSchema.nullable(),
  harness: z.object({
    run: z.string().min(1),
    round: z.string().min(1),
    provenance: z.object({ commit: z.string(), tarballs: z.record(z.string()) }).passthrough(),
    automaticProblems: z.array(z.discriminatedUnion('kind', [refusalAllowed, googleHost])),
  }).passthrough(),
}).passthrough();

export type KeptRun = z.infer<typeof keptRunSchema>;

export function readKeptRun(path: string): Parsed<KeptRun> {
  if (!existsSync(path)) return { ok: false, errors: [`no kept run record ${path}`] };
  const json = parseJsonText(readFileSync(path, 'utf8'));
  return json.ok ? parseWith(keptRunSchema, json.value) : json;
}

const SLUG_LIMIT = 60;

/** `value` in lowercase letters, digits and dashes only, so it can never name another directory. */
export function slugOf(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_LIMIT).replace(/-+$/, '');
  return slug === '' ? 'problem' : slug;
}

/** A slug per selector, each unique: a later one that would repeat an earlier one's gets `-2`, `-3`, and so on. */
function uniqueSlugs(): (selector: string) => string {
  const taken = new Set<string>();
  return (selector) => {
    const base = slugOf(selector);
    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
    taken.add(slug);
    return slug;
  };
}

/** Every problem of the run that `reproduce` can re-run, in the record's order, each with a slug no other has. */
export function reproTargets(run: KeptRun): ReproTarget[] {
  const slug = uniqueSlugs();
  const problems = (run.builder?.problems ?? []).map((problem): ReproTarget => ({ kind: 'builder-problem', selector: problem.id, slug: slug(problem.id), problem }));
  const automatic = run.harness.automaticProblems;
  const refusals = automatic.flatMap((problem) => (problem.kind === 'refusal-allowed' ? [problem] : []));
  const allowed = refusals.map(({ action, productionAnswer, pyricAnswer }, index): ReproTarget => {
    const selector = `refusal-allowed-${index + 1}`;
    return { kind: 'refusal-allowed', selector, slug: slug(selector), action, productionAnswer, pyricAnswer };
  });
  const hosts = automatic.flatMap((problem): ReproTarget[] => {
    if (problem.kind !== 'google-host') return [];
    const selector = `google-host:${problem.host}`;
    return [{ kind: 'google-host', selector, slug: slug(selector), host: problem.host }];
  });
  return [...problems, ...allowed, ...hosts];
}

/** The target `selector` names, or an error that lists every selector the run has. */
export function findTarget(run: KeptRun, selector: string): { target?: ReproTarget; error?: string } {
  const targets = reproTargets(run);
  const target = targets.find((candidate) => candidate.selector === selector);
  if (target !== undefined) return { target };
  const known = targets.length === 0 ? 'none' : targets.map((candidate) => candidate.selector).join(', ');
  return { error: `run ${run.harness.run} has no problem "${selector}"; its problems: ${known}` };
}

/** One line per target, for `reproduce <round> <run> --list`. */
export function targetLine(target: ReproTarget): string {
  if (target.kind === 'builder-problem') return `${target.selector}\tbuilder problem: ${target.problem.summary}`;
  if (target.kind === 'refusal-allowed') return `${target.selector}\tallowed, production answers ${target.productionAnswer}: ${target.action}`;
  return `${target.selector}\tGoogle host the run reached for`;
}
