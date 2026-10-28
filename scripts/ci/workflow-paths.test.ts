import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const workflowDir = resolve(root, '.github/workflows');

function trackedFiles(): string[] {
  const out = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root });
  if (out.exitCode !== 0) throw new Error('git ls-files failed');
  return out.stdout.toString().split('\0').filter(Boolean);
}

interface PathFilter {
  workflow: string;
  event: string;
  key: 'paths' | 'paths-ignore';
  glob: string;
}

function pathFilters(): PathFilter[] {
  const filters: PathFilter[] = [];
  for (const workflow of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
    const parsed = Bun.YAML.parse(readFileSync(resolve(workflowDir, workflow), 'utf8')) as {
      on?: Record<string, { paths?: string[]; 'paths-ignore'?: string[] } | null>;
    };
    for (const [event, config] of Object.entries(parsed.on ?? {})) {
      for (const key of ['paths', 'paths-ignore'] as const) {
        for (const glob of config?.[key] ?? []) filters.push({ workflow, event, key, glob });
      }
    }
  }
  return filters;
}

describe('workflow path filters', () => {
  test('every paths glob matches at least one tracked file', () => {
    const files = trackedFiles();
    const dead = pathFilters()
      .filter((filter) => !filter.glob.startsWith('!'))
      .filter((filter) => {
        const glob = new Bun.Glob(filter.glob);
        return !files.some((file) => glob.match(file));
      })
      .map((filter) => `${filter.workflow} on.${filter.event}.${filter.key}: ${filter.glob}`);
    expect(dead).toEqual([]);
  });

  test('the filter list is not empty, so the test cannot pass vacuously', () => {
    expect(pathFilters().length).toBeGreaterThan(0);
  });
});
