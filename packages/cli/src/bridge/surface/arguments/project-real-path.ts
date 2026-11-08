/**
 * Real-path containment guard for bridge surface methods that read project
 * files or directories. Extends `projectPathWithin` by resolving symbolic
 * links on existing entries (or the nearest existing ancestor directory)
 * against `realpathSync(projectDir)` so symlinks inside the project cannot
 * escape outside it.
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { CAPTURE_RELATIVE_PATH } from '../../../serve/capture-store.js';
import type { Fail, InvalidArguments } from '../method-types.js';
import { projectPathWithin } from './sandbox.js';

function refuseOutside(candidate: string, field: string, fail: Fail): InvalidArguments {
  return fail(
    `'${field}' is '${candidate}', which is outside the project directory.`,
    `Pass '${field}' as a path inside the project directory, such as '${CAPTURE_RELATIVE_PATH}'.`,
    field,
  );
}

function tryLstat(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

export function realProjectPathWithin(
  projectDir: string,
  candidate: string,
  field: string,
  fail: Fail,
): { path: string } | InvalidArguments {
  const lexical = projectPathWithin(projectDir, candidate, field, fail);
  if (!('path' in lexical)) return lexical;

  let realProject = resolve(projectDir);
  if (existsSync(projectDir)) {
    try {
      realProject = realpathSync(projectDir);
    } catch {
      realProject = resolve(projectDir);
    }
  }

  const lst = tryLstat(lexical.path);
  if (lst !== null) {
    let realTarget: string;
    try {
      realTarget = realpathSync(lexical.path);
    } catch {
      return refuseOutside(candidate, field, fail);
    }
    const realChecked = projectPathWithin(realProject, realTarget, field, fail);
    if (!('path' in realChecked)) {
      return refuseOutside(candidate, field, fail);
    }
    const relInside = relative(realProject, realTarget);
    return { path: resolve(projectDir, relInside) };
  }

  let ancestor = dirname(lexical.path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (existsSync(ancestor)) {
    let realAncestor = ancestor;
    try {
      realAncestor = realpathSync(ancestor);
    } catch {
      return refuseOutside(candidate, field, fail);
    }
    const suffix = relative(ancestor, lexical.path);
    const projected = resolve(realAncestor, suffix);
    const realChecked = projectPathWithin(realProject, projected, field, fail);
    if (!('path' in realChecked)) {
      return refuseOutside(candidate, field, fail);
    }
  }

  return lexical;
}
