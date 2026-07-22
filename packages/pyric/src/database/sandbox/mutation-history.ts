import { joinPath, pathSegments } from './data-tree.js';

function pathsOverlap(left: string, right: string): boolean {
  if (left === '/' || right === '/') return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export class MutationHistory {
  private version = 0;
  private readonly activeVersions: number[] = [];
  private readonly mutations: Array<{ version: number; paths: string[] }> = [];

  get entries(): Array<{ version: number; paths: string[] }> {
    return this.mutations;
  }

  get currentVersion(): number {
    return this.version;
  }

  begin(): number {
    const version = this.version;
    this.activeVersions.push(version);
    return version;
  }

  mark(paths: string | string[] = '/'): void {
    this.version += 1;
    if (this.activeVersions.length > 0) {
      this.mutations.push({
        version: this.version,
        paths: (Array.isArray(paths) ? paths : [paths]).map((path) => joinPath(pathSegments(path))),
      });
    }
  }

  conflictsSince(version: number, path: string): boolean {
    const canonical = joinPath(pathSegments(path));
    return this.mutations.some((mutation) =>
      mutation.version > version
      && mutation.paths.some((mutatedPath) => pathsOverlap(canonical, mutatedPath)));
  }

  release(version: number): void {
    const index = this.activeVersions.lastIndexOf(version);
    if (index >= 0) this.activeVersions.splice(index, 1);
    if (this.activeVersions.length === 0) {
      this.mutations.length = 0;
      return;
    }
    const oldest = Math.min(...this.activeVersions);
    const firstRelevant = this.mutations.findIndex((mutation) => mutation.version > oldest);
    if (firstRelevant < 0) this.mutations.length = 0;
    else if (firstRelevant > 0) this.mutations.splice(0, firstRelevant);
  }
}
