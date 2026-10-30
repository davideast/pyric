/** The harness commands' argument helpers. A bad argument is a `UsageError`: exit 2 with the usage. */

export class UsageError extends Error {}

/** The value after `flag`, or undefined when the flag is absent. */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  const isMissing = value === undefined || value.startsWith('--');
  if (isMissing) throw new UsageError(`${flag} takes a value`);
  return value;
}

export function rejectUnknownFlags(args: readonly string[], known: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith('--') && !known.includes(arg));
  if (unknown.length > 0) throw new UsageError(`unknown option: ${unknown.join(', ')}`);
}

/** The arguments that are neither flags nor the value of one of `valueFlags`. */
export function positionals(args: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  return args.filter((arg, index) => {
    const isFlag = arg.startsWith('--');
    const isFlagValue = index > 0 && valueFlags.has(args[index - 1] ?? '');
    return !isFlag && !isFlagValue;
  });
}
