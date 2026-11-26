/**
 * Parses `pyric-live` host-mode flags owned by `@pyric/live` (`--help`/`-h`,
 * `--allow-remote-live`, and `--pass-through`) before passing the remaining
 * flags through to `runLiveHost`.
 */
import { passThroughOption } from './refusal.js';

export const LIVE_HOST_ENTRY = 'pyric-live';

const PASS_THROUGH_FLAG = '--pass-through';
const PASS_THROUGH_PREFIX = '--pass-through=';
const ALLOW_REMOTE_LIVE_FLAG = '--allow-remote-live';

const MISSING_PASS_THROUGH_MESSAGE =
  `${LIVE_HOST_ENTRY}: --pass-through needs a Firebase import, such as --pass-through firebase/functions.`;

const EMPTY_PASS_THROUGH_ENTRY_MESSAGE =
  `${LIVE_HOST_ENTRY}: --pass-through contains an empty entry; pass comma-separated Firebase imports such as --pass-through firebase/functions,firebase/remote-config.`;

type ParsedLiveHostArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'start';
      readonly allowRemotePeers: boolean;
      readonly passThrough: readonly string[];
      readonly hostArgv: readonly string[];
    };

type SplitPassThroughResult =
  | { readonly ok: true; readonly items: readonly string[] }
  | { readonly ok: false; readonly message: string };

function splitPassThroughValue(raw: string): SplitPassThroughResult {
  if (raw.trim().length === 0) {
    return { ok: false, message: MISSING_PASS_THROUGH_MESSAGE };
  }
  const parts = raw.split(',');
  const items: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      return { ok: false, message: EMPTY_PASS_THROUGH_ENTRY_MESSAGE };
    }
    items.push(trimmed);
  }
  return { ok: true, items };
}

/**
 * Splits `pyric-live` host arguments into validated `passThrough` entries,
 * `--allow-remote-live`, and the remaining flags forwarded to `runLiveHost`.
 */
export function parseLiveHostArgs(argv: readonly string[]): ParsedLiveHostArgs {
  let allowRemotePeers = false;
  const hostArgv: string[] = [];
  const rawPassThrough: string[] = [];
  let firstError: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--') {
      hostArgv.push(...argv.slice(i));
      break;
    }
    if (arg === '--help' || arg === '-h') {
      return { kind: 'help' };
    }
    if (arg === ALLOW_REMOTE_LIVE_FLAG) {
      allowRemotePeers = true;
      continue;
    }
    if (arg === PASS_THROUGH_FLAG) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        if (firstError === null) firstError = MISSING_PASS_THROUGH_MESSAGE;
        continue;
      }
      i += 1;
      const split = splitPassThroughValue(next);
      if (!split.ok) {
        if (firstError === null) firstError = split.message;
        continue;
      }
      rawPassThrough.push(...split.items);
      continue;
    }
    if (arg.startsWith(PASS_THROUGH_PREFIX)) {
      const raw = arg.slice(PASS_THROUGH_PREFIX.length);
      const split = splitPassThroughValue(raw);
      if (!split.ok) {
        if (firstError === null) firstError = split.message;
        continue;
      }
      rawPassThrough.push(...split.items);
      continue;
    }
    hostArgv.push(arg);
  }

  if (firstError !== null) {
    return { kind: 'error', message: firstError };
  }

  let passThrough: readonly string[];
  try {
    passThrough = passThroughOption(LIVE_HOST_ENTRY, rawPassThrough);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message };
  }

  return {
    kind: 'start',
    allowRemotePeers,
    passThrough,
    hostArgv,
  };
}
