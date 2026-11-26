import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function loadPolicyApi(installedPackage) {
  const parent = pathToFileURL(resolve(installedPackage, 'package.json')).href;
  return import(import.meta.resolve('@pyric/rules/experimental/policy', parent));
}
