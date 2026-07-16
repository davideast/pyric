import type { CompatibilityRow, Surface } from './types.ts';

/**
 * Shared row-authoring adapter for every surface registry.
 *
 * A registry authors each `CompatibilityRow` as a SEED — only the fields that
 * differ from the table's defaults — and `defineRows` assembles the full row:
 *
 *   const row = defineRows({ surface: 'ai', defaults: { status: 'conforms' } });
 *   const rows = [row({ rowRef: 'getai-idempotent', ... }), ...];
 *
 * Field resolution, lowest to highest precedence:
 *   1. built-in defaults — `aliases`/`risk`/`riskReasons`/`oracleObservations`/
 *      `conformanceTests` empty, `riskScore` 0, and `rowNumber` derived from a
 *      purely numeric `rowRef` (else `null`);
 *   2. the table's `defaults`;
 *   3. the seed itself.
 *
 * `id` is always `${surface}#${rowRef}` (the invariant every registry already
 * held) and `surface` comes from config unless the seed overrides it (the
 * messaging registry authors two surface planes in one file). Optional
 * CompatibilityRow fields (`queryable`, `statusNote`, `notes`, ...) are only
 * present on the built row when the seed or defaults provide them.
 *
 * `expandTest` (optional) maps each seed `conformanceTests` entry to its full
 * repo path, so a table whose witnesses all live in one suite directory can
 * author bare file names.
 */

/** Everything an author can state per row; `id` is always derived. */
type SeedFields = Omit<CompatibilityRow, 'id'>;

/** Fields the builder can fill without the table saying anything. */
const BUILT_IN_DEFAULTS = {
  aliases: [] as string[],
  risk: [] as string[],
  riskScore: 0,
  riskReasons: [] as string[],
  oracleObservations: [] as string[],
  conformanceTests: [] as string[],
} satisfies Partial<SeedFields>;

type BuiltInKey = keyof typeof BUILT_IN_DEFAULTS | 'rowNumber' | 'surface';

/** Keys optional on CompatibilityRow itself — never required in a seed. */
type InherentlyOptionalKey = {
  [K in keyof SeedFields]-?: undefined extends SeedFields[K] ? K : never;
}[keyof SeedFields];

/**
 * The seed shape for a table: fields covered by the table's `defaults`, the
 * built-in defaults, or optional on CompatibilityRow may be omitted; every
 * other field must be authored per row. `rowRef` is always required — it is
 * the row's identity.
 */
export type RowSeed<D extends Partial<SeedFields>> = { rowRef: string } & Omit<
  SeedFields,
  'rowRef' | BuiltInKey | InherentlyOptionalKey | keyof D
> &
  Partial<Omit<SeedFields, 'rowRef'>>;

export interface DefineRowsConfig<D extends Partial<SeedFields>> {
  surface: Surface;
  /** Table-wide field values; a seed states only its deltas from these. */
  defaults?: D;
  /** Expands each seed `conformanceTests` entry to its full repo path. */
  expandTest?: (test: string) => string;
}

function definedEntries(source: Partial<SeedFields>): Partial<SeedFields> {
  return Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined)) as Partial<SeedFields>;
}

/** `rowNumber` for a purely numeric rowRef is that number; otherwise null. */
function defaultRowNumber(rowRef: string): number | null {
  return /^\d+$/.test(rowRef) ? Number(rowRef) : null;
}

export function defineRows<const D extends Partial<SeedFields>>(
  config: DefineRowsConfig<D>,
): (seed: RowSeed<D>) => CompatibilityRow {
  const defaults = definedEntries(config.defaults ?? {});
  return (seed: RowSeed<D>): CompatibilityRow => {
    const merged = {
      rowNumber: defaultRowNumber(seed.rowRef),
      ...BUILT_IN_DEFAULTS,
      ...defaults,
      ...definedEntries(seed),
    } as SeedFields;
    const surface = merged.surface ?? config.surface;
    const conformanceTests = config.expandTest ? merged.conformanceTests.map(config.expandTest) : merged.conformanceTests;
    return { ...merged, surface, conformanceTests, id: `${surface}#${seed.rowRef}` };
  };
}
