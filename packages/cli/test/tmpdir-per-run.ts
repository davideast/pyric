// Preloaded by packages/cli/bunfig.toml so every `bun test` run in packages/cli
// isolates TMPDIR inside ~/.cache/pyric-tmp/cli-* and removes it afterAll.
import { afterAll } from 'bun:test';
import {
  createPrivateJobTmpDir,
  reapDeadPrivateJobTmpDirs,
  removePrivateJobTmpDir,
} from '../../../scripts/lib/private-job-tmpdir.ts';

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

reapDeadPrivateJobTmpDirs();
const previousTmpDir = process.env.TMPDIR;
const previousTmp = process.env.TMP;
const previousTemp = process.env.TEMP;
const runDir = createPrivateJobTmpDir(`cli-${String(process.pid)}`);
process.env.TMPDIR = runDir;
process.env.TMP = runDir;
process.env.TEMP = runDir;
afterAll(() => {
  restoreEnvVar('TMPDIR', previousTmpDir);
  restoreEnvVar('TMP', previousTmp);
  restoreEnvVar('TEMP', previousTemp);
  removePrivateJobTmpDir(runDir);
});
