import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnJob } from './spawn-job.ts';

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('spawnJob scoped TMPDIR cleanup', () => {
  it('assigns an isolated TMPDIR to each child job and unlinks it even when the child leaves files or fails', async () => {
    const work = mkdtempSync(join(tmpdir(), 'pyric-spawn-job-ut-'));
    scratchDirs.push(work);
    const scriptPath = join(work, 'leak-tmp.mjs');
    writeFileSync(
      scriptPath,
      [
        "import { mkdtempSync, writeFileSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        "const childTmp = tmpdir();",
        "const leaked = mkdtempSync(join(childTmp, 'leaked-sub-'));",
        "writeFileSync(join(leaked, 'payload.txt'), 'leftover');",
        "console.log(JSON.stringify({ childTmp, leaked }));",
        'process.exit(1);',
      ].join('\n'),
    );

    const outcome = await spawnJob(
      {
        name: 'leak-tmp',
        command: 'node',
        args: [scriptPath],
        cwd: work,
      },
      { logPath: join(work, 'job.log'), echo: false },
    );

    expect(outcome.exitCode).toBe(1);
    const jsonLine = outcome.tail.find((line) => line.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine ?? '{}') as { childTmp?: string; leaked?: string };
    expect(parsed.childTmp).toContain('pyric-jt-');
    expect(existsSync(parsed.childTmp ?? '')).toBe(false);
    expect(existsSync(parsed.leaked ?? '')).toBe(false);
  });
});
