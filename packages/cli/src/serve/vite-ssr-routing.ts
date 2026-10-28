/**
 * Routing `firebase/*` and `firebase-admin/*` in server-rendered modules under
 * `vite dev` (#1123).
 *
 * Vite's import analysis skips an SSR specifier it would externalize before
 * any plugin `resolveId` runs, and installed packages are externalized by
 * default (Vite 7.3.2, `config.js` 27175). Only a `resolve.alias` match gets
 * past that check, so the plugin aliases each specifier it routes to a
 * prefixed id its own `resolveId` owns, in every environment:
 *
 * - The client keeps the swap it has always had (`vite-module-swap.ts`).
 * - A server module Vite runs in this process (`server.ssrLoadModule`, a
 *   runnable environment) gets what the register maps a remotely activated
 *   Node process to (`mapFirebaseSpecifier`, #1082): the Node client for
 *   `firebase/app`, `auth`, `database`, `firestore` and `storage`, the
 *   refusing `pyric` mirror for the other served services, and `pyric-admin`
 *   for `firebase-admin/*`. The in-process activation
 *   (`vite-ssr-activation.ts`) points them at this dev server's host.
 * - A server environment Vite does not run in this process (workerd and other
 *   non-runnable environments) gets a module that throws when it loads: the
 *   Node client cannot run there, and the real SDK would reach production
 *   from a runtime the network guard does not cover.
 *
 * Each routed import loads through a shim that awaits
 * `@pyric/cli/vite/ssr-loader` (see that module for why).
 */
import { SDK_MODULES, type AiMode } from './firebase-module-swap.js';
import { mapFirebaseSpecifier } from '../register/mapping.js';
import { VITE_SSR_ISSUE_URL } from './vite-net-guard.js';

/** The prefix the alias gives a routed specifier; only this plugin resolves it. */
export const SSR_SWAP_PREFIX = '\0pyric-ssr-swap:';
const TARGET_PREFIX = '\0pyric-ssr-target:';
const OUTSIDE_PREFIX = '\0pyric-ssr-outside:';
const SSR_LOADER = '@pyric/cli/vite/ssr-loader';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** The served `firebase/*` specifiers and every `firebase-admin` subpath. */
const ROUTED_SPECIFIER = new RegExp(
  `^(${SDK_MODULES.map(escapeForPattern).join('|')}|firebase-admin(?:\\/[a-z-]+)?)$`,
);

/** The alias that carries each routed specifier past Vite's SSR externalization. */
export function ssrSwapAlias(): { find: RegExp; replacement: string } {
  return { find: ROUTED_SPECIFIER, replacement: `${SSR_SWAP_PREFIX}$1` };
}

/** The original specifier of an aliased id, or null for any other id. */
export function unaliasedSpecifier(source: string): string | null {
  const isAliased = source.startsWith(SSR_SWAP_PREFIX);
  return isAliased ? source.slice(SSR_SWAP_PREFIX.length) : null;
}

export interface ServerRouteInput {
  specifier: string;
  importer: string | undefined;
  aiMode: AiMode;
  /** Whether Vite runs this environment's modules in this process. */
  runsInProcess: boolean;
  /** The environment's name, for the refusal. */
  environmentName: string;
}

/** A routed module id, or null when the specifier keeps its own resolution (the real SDK). */
export function routeServerImport(input: ServerRouteInput): string | null {
  const runsElsewhere = !input.runsInProcess;
  if (runsElsewhere) return `${OUTSIDE_PREFIX}${input.environmentName}:${input.specifier}`;
  const target = mapFirebaseSpecifier(input.specifier, input.importer, { sandbox: 'remote', aiMode: input.aiMode });
  return target === null ? null : `${TARGET_PREFIX}${target}`;
}

function outsideModule(rest: string): string {
  const separator = rest.lastIndexOf(':');
  const environment = rest.slice(0, separator);
  const specifier = rest.slice(separator + 1);
  const message =
    `pyric: ${specifier} in the Vite "${environment}" environment runs outside the dev server's Node process, ` +
    'where pyric cannot route it to the sandbox. pyric routes firebase/* and firebase-admin/* in ' +
    'server-rendered modules that Vite runs in its own Node process (server.ssrLoadModule or a runnable ' +
    `environment) with pyric({ hosted: true }). See ${VITE_SSR_ISSUE_URL}.`;
  return `throw new Error(${JSON.stringify(message)});\n`;
}

function exportedAs(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** The shim for a routed target: the target's exports, loaded once per process. */
export function targetShim(target: string, names: readonly string[]): string {
  const bindings = names.map((name, index) => `const __pyric${index} = __pyricTarget[${JSON.stringify(name)}];`);
  const exported = names.map((name, index) => `__pyric${index} as ${exportedAs(name)}`);
  return [
    `import { loadServerTarget } from ${JSON.stringify(SSR_LOADER)};`,
    `const __pyricTarget = await loadServerTarget(${JSON.stringify(target)});`,
    ...bindings,
    `export { ${exported.join(', ')} };`,
    '',
  ].join('\n');
}

/**
 * The source of a routed id, or null for any other id. `exportsOf` loads a
 * target in this process to read its export names.
 */
export async function loadRoutedModule(
  id: string,
  exportsOf: (target: string) => Promise<Record<string, unknown>>,
): Promise<string | null> {
  const isOutside = id.startsWith(OUTSIDE_PREFIX);
  if (isOutside) return outsideModule(id.slice(OUTSIDE_PREFIX.length));
  const isTarget = id.startsWith(TARGET_PREFIX);
  if (!isTarget) return null;
  const target = id.slice(TARGET_PREFIX.length);
  return targetShim(target, Object.keys(await exportsOf(target)));
}
