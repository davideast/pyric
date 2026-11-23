interface RuntimeVersions {
  readonly bun?: string;
}

/**
 * Selects the Node.js command used to launch `stand-in.mjs` (#3284).
 *
 * When the scenario runner executes under Bun, `process.versions.bun` is
 * populated regardless of the binary filename (`bun`, `bun.exe` from the npm
 * `bun` package on Linux/macOS or native Bun on Windows, or a versioned binary
 * name), so we spawn `'node'` from `PATH`. When already running under Node.js,
 * we reuse `execPath` directly.
 */
export function standInNodeCommand(
  versions: RuntimeVersions = process.versions,
  execPath: string = process.execPath,
): string {
  const runsUnderBun = typeof versions.bun === 'string' && versions.bun.length > 0;
  if (runsUnderBun) {
    return 'node';
  }
  return execPath;
}
