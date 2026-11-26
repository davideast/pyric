/**
 * Minimal CommonJS and ESM module-instrumentation stand-ins used by
 * `supplied-entry.test.ts`.
 */

/** Stand-in for `require-in-the-middle` (v7/v8) main-entry probe + `onrequire` wrapping. */
export const RITM_INDEX_CJS = `'use strict';
const Module = require('node:module');
const path = require('node:path');
function moduleDetailsFromPath(filename) {
  const segs = filename.split(path.sep);
  const nmIdx = segs.lastIndexOf('node_modules');
  if (nmIdx === -1 || nmIdx + 1 >= segs.length) return undefined;
  const first = segs[nmIdx + 1];
  if (first.startsWith('@')) {
    if (nmIdx + 2 >= segs.length) return undefined;
    return { name: first + '/' + segs[nmIdx + 2], basedir: segs.slice(0, nmIdx + 3).join(path.sep) };
  }
  return { name: first, basedir: segs.slice(0, nmIdx + 2).join(path.sep) };
}
function Hook(modules, options, onrequire) {
  if ((this instanceof Hook) === false) return new Hook(modules, options, onrequire);
  if (typeof modules === 'function') { onrequire = modules; modules = null; options = {}; }
  else if (typeof options === 'function') {
    onrequire = options;
    options = Array.isArray(modules) ? {} : (modules || {});
    if (!Array.isArray(modules)) modules = null;
  }
  const hasWhitelist = Array.isArray(modules);
  const internals = options ? options.internals === true : false;
  const self = this;
  this.cache = new Map();
  this._origRequire = Module.prototype.require;
  this._require = Module.prototype.require = function patchedRequire(id) {
    let filename;
    try { filename = Module._resolveFilename(id, this); } catch (_err) { return self._origRequire.apply(this, arguments); }
    if (Module.isBuiltin(filename)) return self._origRequire.apply(this, arguments);
    if (self.cache.has(filename)) return self.cache.get(filename);
    const exports = self._origRequire.apply(this, arguments);
    const stat = moduleDetailsFromPath(filename);
    if (stat === undefined || (hasWhitelist && !modules.includes(stat.name))) return exports;
    if (!internals) {
      let res;
      try { res = require.resolve(stat.name, { paths: [stat.basedir] }); } catch (_err) { return exports; }
      if (res !== filename) return exports;
    }
    const patched = onrequire ? onrequire(exports, stat.name, stat.basedir) : exports;
    self.cache.set(filename, patched);
    return patched;
  };
}

Hook.prototype.unhook = function unhook() {
  if (Module.prototype.require === this._require) Module.prototype.require = this._origRequire;
};

module.exports = Hook;
module.exports.Hook = Hook;
`;

export const IITM_REGISTER_MJS = `const INCLUDED = /^(?:.*\\/)?node_modules\\/(?:@firebase\\/[^/]+|firebase|firebase-admin)\\//;
export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes('?iitm=true')) return { url: specifier, format: 'module', shortCircuit: true };
  if (specifier.includes('?iitm=ignore')) {
    return { url: specifier.replace('?iitm=ignore', ''), format: 'module', shortCircuit: true };
  }
  let parentURL = context.parentURL;
  if (parentURL && parentURL.includes('?iitm=true')) {
    parentURL = parentURL.replace('?iitm=true', '');
  }
  const result = await nextResolve(specifier, { ...context, parentURL });
  if (result.url.startsWith('file://') && INCLUDED.test(result.url) && result.format === 'module') {
    return { url: result.url + '?iitm=true', format: 'module', shortCircuit: true };
  }
  return result;
}
export async function load(url, context, nextLoad) {
  if (!url.includes('?iitm=true')) return nextLoad(url, context);
  const realUrl = url.replace('?iitm=true', '');
  return { format: 'module', source: 'export * from ' + JSON.stringify(realUrl + '?iitm=ignore') + ';\\n', shortCircuit: true };
}
`;
