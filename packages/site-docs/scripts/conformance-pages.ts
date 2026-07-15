import { resolve } from 'node:path';
import {
  compatibilityPageCatalog,
  deriveConformanceModel,
  renderAllCompatibilityMarkdown,
} from '@pyric/conformance/docs';

export interface ConformanceVirtualPage {
  src: string;
  rendered: string;
  label: string;
  pkg: 'cli' | 'pyric';
  slugPrefix?: 'pyric-cli';
}

/** Materialize the model-owned compatibility pages as virtual docs sources.
 * This is the only site adapter for conformance publication. */
export async function loadConformancePages(repoRoot: string): Promise<readonly ConformanceVirtualPage[]> {
  const model = await deriveConformanceModel();
  const rendered = renderAllCompatibilityMarkdown(model);
  const catalog = compatibilityPageCatalog(model);
  const catalogPaths = new Set(catalog.map(({ path }) => path));
  if (catalogPaths.size !== rendered.size || [...rendered.keys()].some((path) => !catalogPaths.has(path))) {
    throw new Error('compatibility page catalog does not exactly own every rendered document');
  }
  return catalog.map(({ path, label }) => {
    const body = rendered.get(path);
    if (body === undefined) throw new Error(`compat renderer did not produce: ${path}`);
    const pkg = path.startsWith('packages/cli/') ? 'cli' : 'pyric';
    return {
      src: resolve(repoRoot, path),
      rendered: body,
      label,
      pkg,
      ...(pkg === 'cli' ? { slugPrefix: 'pyric-cli' as const } : {}),
    };
  });
}
