/**
 * Explicit capture-flag guard for conformance oracle runners.
 *
 * Every capture script defaults to an inert preview (zero ambient credential
 * reads, zero network calls, zero file writes) unless `--write` or `--capture`
 * is explicitly passed on the command line. When `--write` or `--capture` IS
 * passed and required credentials/configuration are absent, the runner fails
 * non-zero naming the missing configuration rather than printing an inert
 * preview.
 */

export const CAPTURE_WRITE_FLAGS = ['--write', '--capture'] as const;

const CAPTURE_FLAG_SET: ReadonlySet<string> = new Set<string>(CAPTURE_WRITE_FLAGS);

export function hasExplicitCaptureFlag(args: readonly string[]): boolean {
  return args.some((arg) => CAPTURE_FLAG_SET.has(arg));
}

export function stripCaptureFlags(args: readonly string[]): string[] {
  return args.filter((arg) => !CAPTURE_FLAG_SET.has(arg));
}

export function formatInertPreviewFooter(scriptPath: string, extraFlags = ''): string {
  const trimmed = extraFlags.trim();
  let suffix = '';
  if (trimmed) {
    suffix = ` ${trimmed}`;
  }
  return `Pass --write to run against production: bun run ${scriptPath} --write${suffix}`;
}

function printInertPreview(options: {
  label: string;
  scriptPath: string;
  extraFlags?: string;
  summary?: string;
}): void {
  console.log(
    `[${options.label}] INERT preview (no --write flag): zero credential reads, zero network calls.`,
  );
  if (options.summary) {
    console.log(`[${options.label}] ${options.summary}`);
  }
  console.log(`  ${formatInertPreviewFooter(options.scriptPath, options.extraFlags)}`);
}

interface RequireCaptureModeOptions {
  label: string;
  scriptPath: string;
  argv?: readonly string[];
  extraFlags?: string;
  summary?: string;
  preview?: () => void;
  missingCredentials?: () => string | null | undefined;
  exit?: (code: number) => never;
}

export function requireCaptureMode(options: RequireCaptureModeOptions): string[] {
  const rawArgs = options.argv ?? process.argv.slice(2);
  const exitFn = options.exit ?? ((code: number) => process.exit(code));
  if (!hasExplicitCaptureFlag(rawArgs)) {
    if (options.preview) {
      options.preview();
    } else {
      printInertPreview({
        label: options.label,
        scriptPath: options.scriptPath,
        extraFlags: options.extraFlags,
        summary: options.summary,
      });
    }
    return exitFn(0);
  }
  const missing = options.missingCredentials?.();
  if (missing) {
    console.error(`[${options.label}] missing required capture configuration: ${missing}`);
    return exitFn(1);
  }
  return stripCaptureFlags(rawArgs);
}
