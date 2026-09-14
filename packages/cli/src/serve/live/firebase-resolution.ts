import type { Plugin } from 'esbuild';

/** Match owned entry files exactly; a similarly named application file is not an adapter. */
export function isLiveSdkImport(entries: Record<string, string>, source: string, importer?: string): boolean {
  const file = importer?.split('?')[0];
  const hasFile = file !== undefined;
  if (hasFile) {
    const isFirebase = source.startsWith('firebase/');
    const isAdapter = [entries.app, entries.auth, entries.firestore].includes(file);
    const isOwnedImport = isFirebase && isAdapter;
    return isOwnedImport;
  }
  return false;
}

/** Only the selected live adapters bypass the app's Firebase module swap. */
export function firebaseResolvePlugin(
  entries: Record<string, string>,
  projectRoot?: string,
): Plugin {
  const upstreamResolution = Symbol('real Firebase resolution');
  return {
    name: 'pyric-firebase-resolution',
    setup(build) {
      build.onResolve({ filter: /^firebase\// }, (args) => {
        const isUpstreamResolution = args.pluginData === upstreamResolution;
        if (isUpstreamResolution) return undefined;
        const hasLiveProject = projectRoot !== undefined;
        const isLiveAdapter = hasLiveProject && isLiveSdkImport(entries, args.path, args.importer);
        if (isLiveAdapter) {
          return build.resolve(args.path, {
            kind: args.kind,
            resolveDir: projectRoot,
            pluginData: upstreamResolution,
          });
        }
        return { path: args.path, external: true };
      });
    },
  };
}
