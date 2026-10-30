/**
 * The directory of the Next config that calls `withPyric`: Next's project
 * directory, which `next dev apps/web` makes different from the process's
 * working directory. Next passes no directory to a config function, so this
 * reads the caller's file from the call stack. Falls back to the working
 * directory when no caller outside this package can be read.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This package's `next/` directory, whose frames are skipped. */
const OWN_DIR = fileURLToPath(new URL('.', import.meta.url));

function callerFiles(): string[] {
  const holder: { stack?: NodeJS.CallSite[] } = {};
  const previous = Error.prepareStackTrace;
  Error.prepareStackTrace = (_error, frames) => frames;
  try {
    Error.captureStackTrace(holder, callerFiles);
    return (holder.stack ?? []).map((frame) => frame.getFileName() ?? '').filter((file) => file !== '');
  } finally {
    Error.prepareStackTrace = previous;
  }
}

function toPath(file: string): string {
  return file.startsWith('file://') ? fileURLToPath(file) : file;
}

/** The directory of the first file on the stack outside this package's `next/` directory. */
export function callingConfigDir(): string {
  const caller = callerFiles().map(toPath).find((file) => !file.startsWith(OWN_DIR) && !file.startsWith('node:'));
  return caller === undefined ? process.cwd() : dirname(caller);
}
