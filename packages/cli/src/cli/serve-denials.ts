/**
 * `pyric serve denials`: the rules denials the running Node host recorded,
 * grouped by service, instance, rule node and rule.
 *
 *   pyric serve denials [--json] [--since <ms|duration>] [--service rtdb|firestore]
 *
 * Read-only: it reads the host's repro log and joins each denial to the
 * request that opened it, so a path denied on one RTDB instance and allowed on
 * another lists as two groups. The host's log is bounded; when it has dropped
 * older entries, the listing says where its counts start.
 */
import type { ParsedArgs } from './parse-args.js';
import { fetchReproBody, type ServeReproDeps } from './serve-repro.js';
import { parseRepro } from '../serve/repro/format.js';
import { formatDenials, listDenials, type DenialFilter, type DenialService } from '../serve/repro/denials.js';

const SERVICES: readonly DenialService[] = ['rtdb', 'firestore'];
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A duration (`90s`, `5m`, `2h`) or a bare millisecond count, as milliseconds; null when neither. */
export function parseSince(value: string): number | null {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value);
  if (match === null) return null;
  return Number(match[1]) * UNIT_MS[match[2] ?? 'ms'];
}

export async function runServeDenials(
  parsed: ParsedArgs,
  deps: ServeReproDeps & { now?: () => number } = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const filter: DenialFilter = {};
  const since = parsed.flags.get('since');
  if (since !== undefined) {
    const ms = typeof since === 'string' ? parseSince(since) : null;
    if (ms === null) {
      err.write('pyric serve denials: --since is milliseconds or a duration such as 90s, 5m, 2h.\n');
      return 2;
    }
    filter.sinceAt = (deps.now ?? Date.now)() - ms;
  }
  const service = parsed.flags.get('service');
  if (service !== undefined) {
    const known = SERVICES.find((candidate) => candidate === service);
    if (known === undefined) {
      err.write("pyric serve denials: --service is 'rtdb' or 'firestore'.\n");
      return 2;
    }
    filter.service = known;
  }
  const fetched = await fetchReproBody('serve denials', cwd, err, deps.discover);
  if (typeof fetched !== 'string') return fetched.exit;
  let repro: ReturnType<typeof parseRepro>;
  try {
    repro = parseRepro(JSON.parse(fetched));
  } catch (error) {
    err.write(`pyric serve denials: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const groups = listDenials(repro, filter);
  const loggedFrom = repro.truncated ? repro.base.at : undefined;
  const json = Boolean(parsed.flags.get('json'));
  const listing = { denials: groups, truncated: repro.truncated, ...(loggedFrom === undefined ? {} : { from: loggedFrom }) };
  out.write(json ? `${JSON.stringify(listing, null, 2)}\n` : formatDenials(groups, loggedFrom));
  return 0;
}
