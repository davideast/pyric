/**
 * What a role's Codex session is told. Its instructions are the role's
 * skill, `.agents/skills/factory-<role>/SKILL.md` in the pyric checkout the
 * harness runs from, which Codex gets as developer instructions. The skills
 * name the run's directories as `$BRIEF_DIR`, `$RUN_DIR` and `$APP_DIR`;
 * the session's environment sets them, and its prompt names them with the
 * seat and the deadline, then gives the supervisor's prompt.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role, SessionOptions } from './session.ts';

const SKILLS = fileURLToPath(new URL('../../../.agents/skills', import.meta.url));

/** The role's skill file. Throws, naming the path, when the checkout has none: a session never runs without its rules. */
export function roleSkill(role: Role, skills: string = SKILLS): string {
  const file = join(skills, `factory-${role}`, 'SKILL.md');
  if (!existsSync(file)) throw new Error(`no skill for the ${role} role at ${file}: the factory's role skills must be in the checkout it runs from`);
  return file;
}

export interface SessionDirs {
  briefDir: string;
  runDir: string;
  appDir: string;
}

/** The session's prompt: the role, seat and directories, the run's end, then the supervisor's prompt. */
export function rolePrompt(role: Role, options: Pick<SessionOptions, 'seat' | 'prompt' | 'deadline'>, dirs: SessionDirs): string {
  return [
    `You are the factory's ${role}, in seat ${options.seat}. Your instructions are the factory-${role} skill.`,
    `$BRIEF_DIR is ${dirs.briefDir} (read-only), $RUN_DIR is ${dirs.runDir} and $APP_DIR is ${dirs.appDir}; all three are set in your environment.`,
    `Other sessions read the work list while you work: change it only by writing the whole new list to a temporary file beside it, then renaming that file over ${join(dirs.runDir, 'work-list.json')}.`,
    `The run ends at ${options.deadline}.`,
    '',
    options.prompt,
  ].join('\n');
}
