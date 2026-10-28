/**
 * The project's listener-owner settings: `owners` in `pyric.json`, overridden
 * field by field by the Vite plugin's `owners` option.
 *
 * `skip` names the application's data-layer wrapper modules, so a listener's
 * owner shows the code that called the wrapper rather than the wrapper.
 * `frames` is how many application frames each owner keeps, counted from the
 * frame it shows. The resolved settings travel to the page with its transport
 * selection, where every listener attach reads them.
 */

/** JSON project configuration for listener and operation owners. */
export interface OwnersConfig {
  /** Globs for modules whose frames an owner never shows first, e.g. `src/db/**`. */
  skip?: string[];
  /** Application frames each owner keeps, counted from the shown frame. Default 3. */
  frames?: number;
}

/** The project's owner settings, or `undefined` when neither source sets any. */
export function resolveOwnersConfig(base: unknown, overrides?: OwnersConfig): OwnersConfig | undefined {
  const config = { ...validate(base, 'pyric.json owners'), ...validate(overrides, 'pyric({ owners })') };
  const isEmpty = config.skip === undefined && config.frames === undefined;
  return isEmpty ? undefined : config;
}

function validate(value: unknown, source: string): OwnersConfig {
  if (value === undefined) return {};
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject) throw new Error(`${source} must be an object`);
  const { skip, frames } = value as Record<string, unknown>;
  const config: OwnersConfig = {};
  if (skip !== undefined) {
    const isGlobList = Array.isArray(skip) && skip.every((glob) => typeof glob === 'string' && glob.trim().length > 0);
    if (!isGlobList) throw new Error(`${source}.skip must be an array of glob strings`);
    config.skip = skip as string[];
  }
  if (frames !== undefined) {
    const isCount = typeof frames === 'number' && Number.isInteger(frames) && frames >= 1;
    if (!isCount) throw new Error(`${source}.frames must be a whole number of at least 1`);
    config.frames = frames;
  }
  return config;
}
