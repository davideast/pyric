import { realpathSync } from 'node:fs';

/** Percent-encoded directory that owns the discovery pointer used by a proxy. */
export const MCP_PROJECT_HEADER = 'x-pyric-project-dir';
/** Host instance pinned during discovery, before the first MCP session exists. */
export const MCP_INSTANCE_HEADER = 'x-pyric-instance-id';

/** Direct endpoint clients have no pointer; discovered connections must match its project. */
export function mcpProjectError(
  header: string | string[] | undefined,
  projectDir: string,
): string | null {
  const usesExplicitEndpoint = header === undefined;
  if (usesExplicitEndpoint) return null;
  const isMalformedHeader = typeof header !== 'string';
  if (isMalformedHeader) return 'Invalid selected MCP project identity.';
  try {
    const selectedProject = decodeURIComponent(header);
    const belongsToAnotherProject = selectedProject !== realpathSync(projectDir);
    if (belongsToAnotherProject) return 'The selected sandbox belongs to another project.';
    return null;
  } catch {
    return 'Invalid selected MCP project identity.';
  }
}
