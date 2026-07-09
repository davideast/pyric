/**
 * The `hosting` deploy provider — the PLURAL/fan-out case that stresses the
 * contract: a hosting deploy expands over selected entries x resolved site ids,
 * so `resolveConfig` returns one unit per site and the dispatcher owns the loop.
 * It also exercises the impure `ConfigSource` (`.firebaserc` target->site, the
 * git branch for `--channel auto`) and the warn-before-deploy pass (returned as
 * `warnings`, not stderr side-effects).
 */
import { resolve as resolvePath } from 'node:path';
import { createHostingDeployTools } from '../tools.js';
import { parseChannelTtl, sanitizeChannelId } from '../hosting/channels.js';
import { buildVersionConfig } from '../hosting/config.js';
import type { HostingJsonConfig } from '../hosting/spec.js';
import type { DeployProvider, ConfigSource, ResolveResult } from '../provider.js';
import { SCOPES } from '../../credentials/core/scopes.js';
import { hasSandboxBuildMarker } from '../../serve/sandbox-marker.js';

/** The args `hosting_deploy` expects, one per (entry x site). */
interface HostingArgs {
  siteId: string;
  localDir: string;
  ignore?: string[];
  config?: Record<string, unknown>;
  channelId?: string;
  channelTtl?: string;
}

type HostingEntry = {
  site?: string;
  target?: string;
  public?: string;
  ignore?: string[];
} & Record<string, unknown>;

export const hostingProvider: DeployProvider<HostingArgs> = {
  target: 'hosting',
  summary: 'Deploy Hosting site(s) declared in firebase.json',
  operations: [{ name: 'deploy', default: true, toolName: 'hosting_deploy' }],
  requiredScope: SCOPES.firebase,
  requiredApis: ['firebasehosting.googleapis.com'],
  tools: (scope) => createHostingDeployTools({ scope }),
  async resolveConfig(_op, src): Promise<ResolveResult<HostingArgs>> {
    const hostingRaw = src.firebaseJson.hosting;
    const entries = (Array.isArray(hostingRaw) ? hostingRaw : hostingRaw ? [hostingRaw] : []).filter(
      (e): e is HostingEntry => !!e && typeof e === 'object',
    );
    if (entries.length === 0) {
      return {
        ok: false,
        message: 'firebase.json has no `hosting` block (need at least one entry with `public` + `site`).',
      };
    }

    // --only hosting:<siteOrTarget> selects by `site` or `target`; default = first.
    const flagOnly = src.flags.get('only');
    let selected: HostingEntry[];
    if (flagOnly !== undefined) {
      const key =
        typeof flagOnly === 'string' && flagOnly.startsWith('hosting:') ? flagOnly.slice('hosting:'.length) : '';
      if (!key) {
        return { ok: false, message: '--only expects `hosting:<siteOrTarget>` (e.g. --only hosting:my-site).' };
      }
      selected = entries.filter((e) => e.site === key || e.target === key);
      if (selected.length === 0) {
        const declared = entries.map((e) => e.site ?? (e.target ? `target '${e.target}'` : '(unnamed)')).join(', ');
        return { ok: false, message: `--only hosting:${key} matches no hosting entry (declared: ${declared}).` };
      }
    } else {
      selected = [entries[0]!];
    }

    // --channel <id|auto> (auto derives from the git branch) + --channel-ttl/--expires.
    const flagChannel = src.flags.get('channel');
    if (flagChannel === true) {
      return { ok: false, message: "--channel requires a value (a channel id, or 'auto')." };
    }
    let channelId: string | undefined;
    if (typeof flagChannel === 'string') {
      if (flagChannel === 'auto') {
        const branch = await src.getGitBranch();
        if (!branch || branch === 'HEAD') {
          return {
            ok: false,
            message:
              '--channel auto could not derive a channel id from git ' +
              `(${branch === 'HEAD' ? 'detached HEAD' : 'not a git repo / git unavailable'}). ` +
              'Pass an explicit id: --channel <id>.',
          };
        }
        channelId = sanitizeChannelId(branch);
        if (!channelId) {
          return {
            ok: false,
            message: `branch '${branch}' sanitizes to an empty channel id. Pass an explicit id: --channel <id>.`,
          };
        }
      } else {
        channelId = flagChannel;
      }
    }
    const flagChannelTtl = src.flags.get('channel-ttl') ?? src.flags.get('expires');
    if (flagChannelTtl !== undefined && channelId === undefined) {
      return { ok: false, message: '--channel-ttl/--expires requires --channel.' };
    }
    let channelTtl: string | undefined;
    if (flagChannelTtl !== undefined) {
      const ttl = parseChannelTtl(typeof flagChannelTtl === 'string' ? flagChannelTtl : '');
      if (!ttl.ok) return { ok: false, message: ttl.message };
      channelTtl = ttl.ttl;
    }

    // Validate each entry + expand to one unit per site. Warnings (non-serving
    // keys) are collected and returned for the dispatcher to print up front.
    const units: HostingArgs[] = [];
    const warnings: string[] = [];
    for (const entry of selected) {
      const label = entry.site ?? entry.target ?? 'hosting';
      if (typeof entry.public !== 'string' || !entry.public) {
        return { ok: false, message: `hosting entry '${label}' has no \`public\` directory.` };
      }
      // Refuse a pyric SANDBOX build (`vite build --mode development`): that output
      // bundles pyric's in-page adapters instead of the real firebase SDK, so
      // deploying it would ship a fake backend to production. The marker in its
      // index.html is the tell. This closes the reverse hole of the `pyric dev`
      // refusal (which stops a REAL-SDK build from being sandboxed).
      if (hasSandboxBuildMarker(resolvePath(src.cwd, entry.public))) {
        return {
          ok: false,
          message:
            `hosting entry '${label}' points at a pyric SANDBOX build (${entry.public} carries the ` +
            `sandbox-build marker). That output bundles pyric's in-page adapters, NOT the real ` +
            `firebase SDK, so it must never be deployed. Rebuild for production with \`vite build\` ` +
            `(the default production mode) before deploying.`,
        };
      }
      let siteIds: string[];
      if (entry.site) {
        siteIds = [entry.site];
      } else if (entry.target) {
        const mapped = src.firebaseRc?.targets?.[src.projectId]?.hosting?.[entry.target];
        if (!Array.isArray(mapped) || mapped.length === 0) {
          return {
            ok: false,
            message:
              `target '${entry.target}' is not mapped to a site in .firebaserc ` +
              `(expected targets.${src.projectId}.hosting.${entry.target}; run ` +
              `\`firebase target:apply hosting ${entry.target} <site>\` or add it by hand).`,
          };
        }
        siteIds = mapped;
      } else {
        return { ok: false, message: 'hosting entry declares neither `site` nor `target`.' };
      }
      const { public: _pub, site: _site, target: _target, ignore, ...servingConfig } = entry;
      const built = buildVersionConfig(servingConfig as HostingJsonConfig);
      if (!built.ok) return { ok: false, message: `invalid hosting config for '${label}': ${built.message}` };
      warnings.push(...built.warnings);
      for (const siteId of siteIds) {
        units.push({
          siteId,
          localDir: resolvePath(src.cwd, entry.public),
          ...(Array.isArray(ignore) ? { ignore } : {}),
          ...(Object.keys(servingConfig).length > 0 ? { config: servingConfig } : {}),
          ...(channelId ? { channelId } : {}),
          ...(channelTtl ? { channelTtl } : {}),
        });
      }
    }
    return { ok: true, units, warnings };
  },
};
