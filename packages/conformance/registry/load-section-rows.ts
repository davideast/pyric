import { createRequire } from 'node:module';
import { lstatSync, readdirSync } from 'node:fs';
import {
  assembleRegistrySections,
  type LoadRegistrySectionsOptions,
  type LoadedRegistrySections,
  type RegistryDirectoryHost,
  type RegistryEntryKind,
} from './section-rows.ts';

const requireModule = createRequire(import.meta.url);

const nodeRegistryDirectoryHost: RegistryDirectoryHost = {
  readDirectory(dirPath: string): readonly string[] {
    return readdirSync(dirPath);
  },
  entryKind(entryPath: string): RegistryEntryKind {
    try {
      const stat = lstatSync(entryPath);
      if (stat.isFile()) return 'file';
      if (stat.isDirectory()) return 'directory';
      return 'other';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'missing';
      }
      throw error;
    }
  },
  loadModule(filePath: string): unknown {
    return requireModule(filePath);
  },
};

export function loadRegistrySections(
  surfaceDir: string,
  options?: LoadRegistrySectionsOptions,
): LoadedRegistrySections {
  return assembleRegistrySections(surfaceDir, nodeRegistryDirectoryHost, options);
}
