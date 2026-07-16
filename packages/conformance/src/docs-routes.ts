/** Convert a canonical generated COMPAT source path to its public docs slug. */
export function compatibilitySlug(compatPath: string): string {
  const pyric = compatPath.match(/^packages\/pyric\/docs\/(.+)\/COMPAT\.md$/)?.[1];
  if (pyric) return `pyric-${pyric.replaceAll('/', '-')}-compat`;
  const cli = compatPath.match(/^packages\/cli\/docs\/(.+)\/COMPAT\.md$/)?.[1];
  if (cli) return `pyric-cli-${cli.replaceAll('/', '-')}-compat`;
  throw new Error(`No docs route for compatibility path: ${compatPath}`);
}

export function compatibilityHref(compatPath: string): string {
  return `../${compatibilitySlug(compatPath)}/`;
}
