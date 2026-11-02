/**
 * What a role's Codex session is told. The supervisor's prompt says what to
 * do this session; the runner puts in front of it who the session is and
 * where the run's shared files are. A role whose skill exists in
 * `.agents/skills/factory-<role>/SKILL.md` also gets the skill, on stdin.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role, SessionOptions } from './session.ts';

const SKILLS = fileURLToPath(new URL('../../../.agents/skills', import.meta.url));

/** One line per role: what it is for. */
const ROLE_LINES: { [role in Role]: string } = {
  lead: 'You are the lead: you plan the work list and keep it in order.',
  builder: 'You are a builder: you take items from the work list and build them in the app.',
  'user-agent': 'You are the user agent: you use the app as a person would and note what breaks.',
  'design-reviewer': 'You are the design reviewer: you review the app’s design and note what to fix.',
  triage: 'You are triage: you read the latest check and the notes, and turn failures into work-list items.',
};

/** The role's skill file, when the repo has one. */
export function roleSkill(role: Role, skills: string = SKILLS): string | undefined {
  const file = join(skills, `factory-${role}`, 'SKILL.md');
  return existsSync(file) ? file : undefined;
}

/** The session's prompt: the role and seat, the shared files, the run's end, then the supervisor's prompt. */
export function rolePrompt(role: Role, options: Pick<SessionOptions, 'seat' | 'prompt' | 'appDir' | 'files' | 'deadline'>): string {
  return [
    `${ROLE_LINES[role]} Your seat is ${options.seat}.`,
    `The app is in ${options.appDir}. The work list is ${options.files.workList}, the progress notes ${options.files.progress}, and the latest check ${options.files.latestCheck}. Read all three before you start, and add to the progress notes before you stop.`,
    `Other sessions read the work list while you work: change it only by writing the whole new list to a temporary file beside it, then renaming that file over ${options.files.workList}.`,
    `The run ends at ${options.deadline}.`,
    '',
    options.prompt,
  ].join('\n');
}
