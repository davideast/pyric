/**
 * Which application frames a `frame` owner records, and which one it shows.
 *
 * Most applications open every listener through one small data-layer helper,
 * so the first application frame on the attaching stack names that helper for
 * every listener in the app. Two settings fix that:
 *
 * - `frames`, how many application frames to keep, counted from the frame the
 *   owner shows. Kept frames ride on the owner as its `stack`, so a consumer
 *   can draw `db.js:5 ← room-list.js:5 ← main.js:14`.
 * - `skip`, globs naming the application's wrapper modules. The owner shows
 *   the first frame outside them, the way a browser debugger blackboxes a
 *   script. The skipped frames stay at the front of `stack`.
 *
 * The policy is set once per page or process by the host that knows the
 * project's configuration (`pyric.json` or the Vite plugin option); everything
 * that captures a frame reads it from here, so the in-page sandbox and a
 * served page's worker client attribute the same call the same way.
 */

/** The project's owner-frame settings, as configuration states them. */
export interface ListenerOwnerFramesPolicy {
  /** Application frames to keep, counted from the shown frame. Default 3. */
  readonly frames?: number;
  /** Globs for modules whose frames are never shown first. Default none. */
  readonly skip?: readonly string[];
}

/** The number of application frames kept when no policy says otherwise. */
export const DEFAULT_OWNER_FRAMES = 3;

interface ResolvedPolicy {
  readonly frames: number;
  readonly skips: (file: string) => boolean;
}

const NEVER_SKIPS = (): boolean => false;

let policy: ResolvedPolicy = { frames: DEFAULT_OWNER_FRAMES, skips: NEVER_SKIPS };

/** Replace the owner-frame policy. Pass `{}` to restore the defaults. */
export function configureListenerOwnerFrames(next: ListenerOwnerFramesPolicy): void {
  const requested = next.frames ?? DEFAULT_OWNER_FRAMES;
  const frames = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : DEFAULT_OWNER_FRAMES;
  const skip = next.skip ?? [];
  policy = { frames, skips: skip.length === 0 ? NEVER_SKIPS : skipMatcher(skip) };
}

/** The policy in force, for the stack reader. */
export function ownerFramesPolicy(): ResolvedPolicy {
  return policy;
}

/**
 * A matcher for frame files against `globs`.
 *
 * A frame file is a filesystem path under Node and a URL in a browser, while
 * a project writes globs relative to its root. So the file is reduced to its
 * path (no origin, query, or hash) and a glob matches when it matches the
 * whole path or any tail of it that starts at a `/`: `src/db/**` matches
 * `/home/me/app/src/db/index.ts` and `http://localhost:5173/src/db/index.ts`
 * alike. `**` spans directories, `*` and `?` stay within one.
 */
export function skipMatcher(globs: readonly string[]): (file: string) => boolean {
  const patterns = globs.map((glob) => new RegExp(`(?:^|/)${globSource(glob)}$`));
  return (file) => {
    const path = framePath(file);
    return patterns.some((pattern) => pattern.test(path));
  };
}

function framePath(file: string): string {
  const withoutOrigin = file.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  const end = withoutOrigin.search(/[?#]/);
  return end === -1 ? withoutOrigin : withoutOrigin.slice(0, end);
}

function globSource(glob: string): string {
  const relative = glob.replace(/^(?:\.\/|\/)+/, '');
  let source = '';
  for (let index = 0; index < relative.length; index += 1) {
    const char = relative[index]!;
    if (char === '*' && relative[index + 1] === '*') {
      const spansDirectory = relative[index + 2] === '/';
      source += spansDirectory ? '(?:.*/)?' : '.*';
      index += spansDirectory ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return source;
}

/**
 * Read a stack deep enough to hold the frames the policy keeps.
 *
 * V8 records ten frames by default, and pyric's own frames between the
 * application and the attach use several of them, so a deep wrapper could
 * push the frame worth showing off the end. The limit is raised for this one
 * capture and restored. Runtimes without `Error.stackTraceLimit` ignore it.
 */
export function captureAttachStack(): string | undefined {
  const errorConstructor = Error as { stackTraceLimit?: number };
  const previous = errorConstructor.stackTraceLimit;
  const raises = typeof previous === 'number' && previous < CAPTURE_DEPTH;
  if (raises) errorConstructor.stackTraceLimit = CAPTURE_DEPTH;
  try {
    const stack = new Error().stack;
    return typeof stack === 'string' ? stack : undefined;
  } finally {
    if (raises) errorConstructor.stackTraceLimit = previous;
  }
}

const CAPTURE_DEPTH = 50;
