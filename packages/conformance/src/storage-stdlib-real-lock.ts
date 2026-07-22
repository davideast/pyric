import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const LOCK_PATH = '/tmp/pyric-storage-stdlib-real.lock';

export function acquireRunLock(lockPath = LOCK_PATH): () => void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
      try {
        process.kill(pid, 0);
        throw new Error(`another storage-stdlib real-resource probe is already running (pid ${pid})`);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        unlinkSync(lockPath);
      }
    }
  }
  throw new Error('could not acquire storage-stdlib real-resource probe lock');
}
