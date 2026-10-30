/**
 * The run root is bound read-write into the sandbox, so anything in it can be
 * a link the builder planted: `network.jsonl` pointing at a file of the
 * host's, or `logs` at a directory outside. The harness reads and appends to
 * those files outside the sandbox, after the sandbox has stopped, so nothing
 * can change them between this check and that use. Before it touches one, it
 * checks that the file is absent or a plain file, and that every directory
 * from the run root down to it is a plain directory.
 */
import { lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** A path the harness was about to touch is, or runs through, a link or something other than a plain file. */
export class PlantedLink extends Error {}

function componentProblem(path: string, isLast: boolean): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink()) return `${path} is a link`;
  const isExpected = isLast ? stat.isFile() : stat.isDirectory();
  return isExpected ? undefined : `${path} is not a plain ${isLast ? 'file' : 'directory'}`;
}

/** Why touching `path` could reach outside `root`; undefined when it can't. */
export function plantedLinkProblem(root: string, path: string): string | undefined {
  const inside = relative(root, path);
  const isInsideRoot = inside !== '' && !inside.startsWith('..') && !inside.startsWith(sep);
  if (!isInsideRoot) return `${path} is not inside the run root ${root}`;
  const rootProblem = componentProblem(root, false);
  if (rootProblem !== undefined) return rootProblem;
  const parts = inside.split(sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const problem = componentProblem(current, index === parts.length - 1);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** Throws `PlantedLink`, naming each problem, unless every path is safe to read or append to. */
export function assertNoPlantedLinks(root: string, paths: readonly string[]): void {
  const problems = paths.map((path) => plantedLinkProblem(root, path)).filter((problem) => problem !== undefined);
  if (problems.length > 0) throw new PlantedLink(`refusing to touch the run's files outside the sandbox:\n- ${problems.join('\n- ')}`);
}
