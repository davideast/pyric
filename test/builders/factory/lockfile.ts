/**
 * What a session's bun.lock may name. Installs run in a sandbox with no
 * network, so a git or URL source would fail there anyway; this names the
 * entry instead of leaving an install error to read. A `bun.lock` package
 * entry is `"name": ["name@<source>", ...]`, where the source is a version
 * from the registry, or `link:`/`workspace:` inside the repo.
 */
const ENTRY = /^\s*"([^"]+)":\s*\["((?:@[^@"/]+\/)?[^@"]+)@([^"]*)"/gm;
const OUTSIDE_SOURCES = /^(git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|ssh:)/;

/** One line per package whose source isn't the npm registry or the repo itself. */
export function lockfileProblems(text: string): string[] {
  const problems: string[] = [];
  for (const match of text.matchAll(ENTRY)) {
    const [, key, name, source] = match;
    if (source === undefined || !OUTSIDE_SOURCES.test(source)) continue;
    problems.push(`${key}: ${name}@${source}`);
  }
  return problems;
}
