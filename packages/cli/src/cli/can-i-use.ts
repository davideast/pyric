import type { ParsedArgs } from './parse-args.js';
import { canIUse } from '../conformance/index.js';

/** Query feature support. This is discovery, independent of rules-fixture
 * verification, so it owns a top-level CLI command. */
export function runCanIUse(parsed: ParsedArgs): number {
  for (const [flag, value] of parsed.flags) {
    const validJsonValue = flag === 'json' && (value === true || value === 'true' || value === 'false');
    if (!validJsonValue) {
      const rendered = value === true ? `--${flag}` : `--${flag}=${String(value)}`;
      process.stderr.write(`pyric can-i-use: unknown option '${rendered}'\n`);
      return 1;
    }
  }
  const feature = parsed.positional.join(' ');
  if (!feature.trim()) {
    process.stderr.write('pyric can-i-use: provide a developer feature name\n');
    return 1;
  }
  const result = canIUse(feature);
  const jsonFlag = parsed.flags.get('json');
  if (jsonFlag === true || jsonFlag === 'true') {
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.match === 'exact' ? 0 : 1;
  }
  if (result.match === 'none') {
    process.stdout.write(`No conformance feature matched "${feature}".\n`);
    return 1;
  }
  if (result.match === 'suggestions') {
    process.stdout.write(`No exact conformance feature matched "${feature}". Did you mean:\n`);
    for (const support of result.supports) process.stdout.write(`  ${support.surface}/${support.feature}\n`);
    return 1;
  }
  if (result.match === 'ambiguous') {
    process.stdout.write(`"${feature}" matches more than one surface:\n`);
  }
  for (const support of result.supports) {
    process.stdout.write(
      `${support.feature} (${support.surface})\n` +
        `  availability: ${support.availability}\n` +
        `  fidelity: ${support.fidelity}\n` +
        `  assurance: ${support.assurance}\n` +
        `  evidence: ${support.evidenceSlug}\n` +
        `  ${support.summary}\n`,
    );
    for (const caveat of support.caveats) process.stdout.write(`  caveat: ${caveat}\n`);
  }
  return result.match === 'exact' ? 0 : 1;
}
