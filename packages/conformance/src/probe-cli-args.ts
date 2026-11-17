/**
 * Single-probe CLI flag reader shared by the installed-SDK probe runners
 * (`admin-app-probes.ts`, `app-registry-probes.ts`, `client-storage-probes.ts`).
 */
export function readSingleProbeSelector(
  args: readonly string[],
  extraPrefixes: readonly string[] = [],
): string | undefined {
  const prefixes = [...extraPrefixes, '--probe='];
  const selected: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--probe') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--probe requires a probe id');
      }
      selected.push(next);
      i += 1;
      continue;
    }
    const matchingPrefix = prefixes.find((prefix) => arg.startsWith(prefix));
    if (matchingPrefix !== undefined) {
      const value = arg.slice(matchingPrefix.length);
      if (!value) throw new Error(`${matchingPrefix} requires a probe id`);
      selected.push(value);
    }
  }

  if (selected.length > 1) {
    throw new Error('only one --probe selector is allowed');
  }
  return selected[0];
}
