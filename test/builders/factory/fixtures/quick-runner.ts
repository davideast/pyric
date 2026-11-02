// A session runner for the supervisor's process test: each session sleeps a
// moment, honoring its signal, and the lead stocks the work list. No agent,
// no model, no network.
import { writeJsonFile } from '../run-dir.ts';
import type { RunSession } from '../session.ts';

const SESSION_MS = 300;

export const runSession: RunSession = async (role, options) => {
  if (role === 'lead') writeJsonFile(options.files.workList, { items: [{ id: 'page', title: 'A page', status: 'todo' }] });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.min(SESSION_MS, options.remainingMs));
    options.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  const logPath = `logs/${options.seat}.log`;
  if (options.signal.aborted) return { exitCode: 143, endedBy: 'killed', logPath };
  return { exitCode: 0, endedBy: 'exit', logPath };
};
