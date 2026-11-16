/**
 * Per-slice subprocess driver script builders for the Node register, Worker
 * options, and preload ordering generative guard suite.
 */
import { TOCTOU_TRAP_KINDS, type ImporterOriginKind } from './register-preload-worker-gen.js';

export interface EvalAndTrapReport {
  readonly evalCases: Record<string, { guarded: boolean; detail?: string }>;
  readonly traps: Record<string, { guarded: boolean; reads: number; detail?: string }>;
}

export interface PreloadDriverReport {
  readonly preloads: Record<string, { guarded: boolean; earlyGuarded: boolean; detail?: string }>;
  readonly dashDash: Record<string, { guarded: boolean; earlyGuarded: boolean; detail?: string }>;
}

export interface NodeEnvMutationReport {
  readonly nodeEnvCases: Record<string, { guarded: boolean; leakedForce: boolean; detail?: string }>;
}

export interface AiModeMutationReport {
  readonly aiCases: Record<string, { loadedRealAi: boolean }>;
}

export interface RequireSpoofReport {
  readonly cases: Record<string, { loadedReal: boolean; code: string | null }>;
}

const DRIVER_PREAMBLE = [
  'import { availableParallelism } from "node:os";',
  'const POOL_LIMIT = Math.max(3, Math.min(16, availableParallelism()));',
  'async function mapPool(items, limit, fn) {',
  '  const out = new Array(items.length);',
  '  let idx = 0;',
  '  async function worker() {',
  '    while (idx < items.length) {',
  '      const cur = idx;',
  '      idx += 1;',
  '      out[cur] = await fn(items[cur]);',
  '    }',
  '  }',
  '  const count = Math.min(limit, items.length);',
  '  const runners = [];',
  '  for (let i = 0; i < count; i += 1) runners.push(worker());',
  '  await Promise.all(runners);',
  '  return out;',
  '}',
  'function runWorker(target, opts) {',
  '  return new Promise((res) => {',
  '    try {',
  '      const w = new Worker(target, opts);',
  '      let msg = null;',
  '      w.once("message", (m) => { msg = m; });',
  '      w.once("error", (e) => res({ ok: false, err: String(e?.code ?? e?.message ?? e), msg }));',
  '      w.once("exit", (code) => res({ ok: code === 0 && msg !== null, code, msg }));',
  '    } catch (e) {',
  '      res({ ok: false, err: String(e?.code ?? e?.message ?? e), msg: null });',
  '    }',
  '  });',
  '}',
  'function collectChildJson(c, prefix) {',
  '  return new Promise((res) => {',
  '    let out = ""; let err = "";',
  '    c.stdout.setEncoding("utf8"); c.stderr.setEncoding("utf8");',
  '    c.stdout.on("data", (d) => { out += d; });',
  '    c.stderr.on("data", (d) => { err += d; });',
  '    c.once("close", (status) => {',
  '      const ln = out.split("\\n").find((l) => l.startsWith(prefix));',
  '      let parsed = null;',
  '      if (ln !== undefined) parsed = JSON.parse(ln.slice(prefix.length));',
  '      res({ status, parsed, stderr: err });',
  '    });',
  '  });',
  '}',
  'function spawnNodeJson(args, env, prefix) {',
  '  const c = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });',
  '  return collectChildJson(c, prefix);',
  '}',
  'function forkNodeJson(modulePath, execArgv, env, prefix) {',
  '  const opts = { env, stdio: ["ignore", "pipe", "pipe", "ipc"] };',
  '  if (execArgv !== undefined) opts.execArgv = execArgv;',
  '  const c = fork(modulePath, [], opts);',
  '  return collectChildJson(c, prefix);',
  '}',
].join('\n');

export function buildEvalDriverSource(input: {
  surface: 'sandbox' | 'live';
  workerFile: string;
  earlyCjsPath: string;
  evalCasesJson: string;
}): string {
  return [
    'import { fork, spawn } from "node:child_process";',
    'import { SHARE_ENV, Worker } from "node:worker_threads";',
    DRIVER_PREAMBLE,
    `const surface = ${JSON.stringify(input.surface)};`,
    `const workerFile = ${JSON.stringify(input.workerFile)};`,
    `const earlyCjsPath = ${JSON.stringify(input.earlyCjsPath)};`,
    `const evalCases = ${input.evalCasesJson};`,
    'function buildEvalCode(bodyKind) {',
    '  if (surface === "sandbox") {',
    '    if (bodyKind === "plain-cjs") {',
    '      return "const { parentPort } = require(\\"node:worker_threads\\"); const a = require(\\"firebase-admin/app\\"); parentPort.postMessage({ guarded: \\"ADMIN_APP_TARGET\\" in a });";',
    '    }',
    '    if (bodyKind === "hoisted-require") {',
    '      return "function require() {}\\nconst { parentPort } = module.require(\\"node:worker_threads\\"); const a = module.require(\\"firebase-admin/app\\"); parentPort.postMessage({ guarded: \\"ADMIN_APP_TARGET\\" in a });";',
    '    }',
    '    return "function require() {}\\nfunction module() {}\\nconst m = process.getBuiltinModule(\\"node:module\\"); const req = m.createRequire(process.cwd() + \\"/package.json\\"); const a = req(\\"firebase-admin/app\\"); const { parentPort } = process.getBuiltinModule(\\"node:worker_threads\\"); parentPort.postMessage({ guarded: \\"ADMIN_APP_TARGET\\" in a });";',
    '  }',
    '  const check = "let code = null; try { const fn = loader(\\"firebase/functions\\"); void fn; } catch (e) { code = e?.code ?? String(e); }";',
    '  if (bodyKind === "plain-cjs") {',
    '    return `const { parentPort } = require("node:worker_threads"); const loader = require; ${check} parentPort.postMessage({ guarded: code === "PYRIC_LIVE_REFUSED" });`;',
    '  }',
    '  if (bodyKind === "hoisted-require") {',
    '    return `function require() {}\\nconst { parentPort } = module.require("node:worker_threads"); const loader = module.require.bind(module); ${check} parentPort.postMessage({ guarded: code === "PYRIC_LIVE_REFUSED" });`;',
    '  }',
    '  return `function require() {}\\nfunction module() {}\\nconst m = process.getBuiltinModule("node:module"); const loader = m.createRequire(process.cwd() + "/package.json"); const { parentPort } = process.getBuiltinModule("node:worker_threads"); ${check} parentPort.postMessage({ guarded: code === "PYRIC_LIVE_REFUSED" });`;',
    '}',
    'function resolveEvalVal(kind) {',
    '  if (kind === "bool-true") return true;',
    '  if (kind === "num-one") return 1;',
    '  if (kind === "str-one") return "1";',
    '  return {};',
    '}',
    'function resolveEnvOpt(kind) {',
    '  if (kind === "default") return undefined;',
    '  if (kind === "null") return null;',
    '  if (kind === "share-env") return SHARE_ENV;',
    '  return { PATH: process.env.PATH };',
    '}',
    'function buildEvalOptions(evalKind, envKind) {',
    '  let opts;',
    '  if (evalKind === "non-enum-true") {',
    '    opts = {};',
    '    Object.defineProperty(opts, "eval", { value: true, enumerable: false, configurable: true });',
    '  } else if (evalKind === "proto-inherited-one") {',
    '    opts = Object.create({ eval: 1 });',
    '  } else {',
    '    opts = { eval: resolveEvalVal(evalKind) };',
    '  }',
    '  if (envKind !== "default") opts.env = resolveEnvOpt(envKind);',
    '  return opts;',
    '}',
    'const evalEntries = await mapPool(evalCases, POOL_LIMIT, async (c) => {',
    '  const opts = buildEvalOptions(c.evalKind, c.envKind);',
    '  const r = await runWorker(buildEvalCode(c.bodyKind), opts);',
    '  return [c.id, { guarded: Boolean(r.ok && r.msg?.guarded), detail: r.err }];',
    '});',
    'const trapEntries = await mapPool(' + JSON.stringify(TOCTOU_TRAP_KINDS) + ', POOL_LIMIT, async (trap) => {',
    '  let reads = 0;',
    '  if (trap === "getter-eval-flip-false") {',
    '    const opts = { get eval() { reads += 1; return reads > 1; } };',
    '    const r = await runWorker(buildEvalCode("plain-cjs"), opts);',
    '    return [trap, { guarded: !r.ok || Boolean(r.msg?.guarded), reads, detail: r.err }];',
    '  }',
    '  if (trap === "proxy-eval-flip-false") {',
    '    const opts = new Proxy({}, { get(_t, p) { if (p === "eval") { reads += 1; return reads > 1; } return undefined; } });',
    '    const r = await runWorker(buildEvalCode("plain-cjs"), opts);',
    '    return [trap, { guarded: !r.ok || Boolean(r.msg?.guarded), reads, detail: r.err }];',
    '  }',
    '  if (trap === "getter-execArgv-inject-r") {',
    '    const opts = { get execArgv() { reads += 1; if (reads === 1) return undefined; return ["-r", earlyCjsPath]; } };',
    '    const r = await runWorker(workerFile, opts);',
    '    return [trap, { guarded: Boolean(r.ok && r.msg?.guarded && r.msg?.earlyGuarded !== false), reads, detail: r.err }];',
    '  }',
    '  if (trap === "proxy-execArgv-inject-r") {',
    '    const opts = new Proxy({}, { get(_t, p) { if (p === "execArgv") { reads += 1; if (reads === 1) return undefined; return ["-r", earlyCjsPath]; } return undefined; } });',
    '    const r = await runWorker(workerFile, opts);',
    '    return [trap, { guarded: Boolean(r.ok && r.msg?.guarded && r.msg?.earlyGuarded !== false), reads, detail: r.err }];',
    '  }',
    '  if (trap === "elem-getter-execArgv-inject-r") {',
    '    const arr = [];',
    '    Object.defineProperty(arr, 0, { enumerable: true, get() { reads += 1; if (reads === 1) return "--no-warnings"; return "-r"; } });',
    '    Object.defineProperty(arr, 1, { enumerable: true, get() { reads += 1; if (reads <= 2) return "--no-warnings"; return earlyCjsPath; } });',
    '    const r = await runWorker(workerFile, { execArgv: arr });',
    '    return [trap, { guarded: Boolean(r.ok && r.msg?.guarded && r.msg?.earlyGuarded !== false), reads, detail: r.err }];',
    '  }',
    '  const opts = { get env() { reads += 1; if (reads === 1) return null; return { PATH: process.env.PATH, NODE_ENV: "production" }; } };',
    '  const r = await runWorker(workerFile, opts);',
    '  return [trap, { guarded: Boolean(r.ok && r.msg?.guarded), reads, detail: r.err }];',
    '});',
    'console.log("EVAL_REPORT " + JSON.stringify({ evalCases: Object.fromEntries(evalEntries), traps: Object.fromEntries(trapEntries) }));',
  ].join('\n');
}

export function buildPreloadDriverSource(input: {
  workerFile: string;
  childFile: string;
  preloadCasesJson: string;
  dashCasesJson: string;
}): string {
  return [
    'import { fork, spawn } from "node:child_process";',
    'import { Worker } from "node:worker_threads";',
    DRIVER_PREAMBLE,
    `const workerFile = ${JSON.stringify(input.workerFile)};`,
    `const childFile = ${JSON.stringify(input.childFile)};`,
    `const preloadCases = ${input.preloadCasesJson};`,
    `const dashCases = ${input.dashCasesJson};`,
    'async function runPreloadChannel(channel, tokens, nodeOptions) {',
    '  if (channel === "worker-execArgv") {',
    '    const r = await runWorker(workerFile, { execArgv: tokens });',
    '    return { guarded: Boolean(r.ok && r.msg?.guarded), earlyGuarded: Boolean(r.ok && r.msg?.earlyGuarded === true), detail: r.err };',
    '  }',
    '  if (channel === "worker-node-options") {',
    '    const r = await runWorker(workerFile, { env: { PATH: process.env.PATH, NODE_OPTIONS: nodeOptions } });',
    '    return { guarded: Boolean(r.ok && r.msg?.guarded), earlyGuarded: Boolean(r.ok && r.msg?.earlyGuarded === true), detail: r.err };',
    '  }',
    '  if (channel === "child-node-options") {',
    '    const c = await spawnNodeJson([childFile], { PATH: process.env.PATH, NODE_OPTIONS: nodeOptions }, "CHILD ");',
    '    return { guarded: Boolean(c.status === 0 && c.parsed?.guarded), earlyGuarded: Boolean(c.status === 0 && c.parsed?.earlyGuarded === true), detail: c.stderr };',
    '  }',
    '  if (channel === "child-fork-execArgv") {',
    '    const c = await forkNodeJson(childFile, tokens, { PATH: process.env.PATH }, "CHILD ");',
    '    return { guarded: Boolean(c.status === 0 && c.parsed?.guarded), earlyGuarded: Boolean(c.status === 0 && c.parsed?.earlyGuarded === true), detail: c.stderr };',
    '  }',
    '  const c = await spawnNodeJson([...tokens, childFile], { PATH: process.env.PATH }, "CHILD ");',
    '  return { guarded: Boolean(c.status === 0 && c.parsed?.guarded), earlyGuarded: Boolean(c.status === 0 && c.parsed?.earlyGuarded === true), detail: c.stderr };',
    '}',
    'const dashEntries = await mapPool(dashCases, POOL_LIMIT, async (d) => {',
    '  return [d.id, await runPreloadChannel(d.channel, d.tokens, "")];',
    '});',
    'const preloadEntries = await mapPool(preloadCases, POOL_LIMIT, async (p) => {',
    '  return [p.id, await runPreloadChannel(p.channel, p.tokens, p.nodeOptions)];',
    '});',
    'console.log("PRELOAD_REPORT " + JSON.stringify({ preloads: Object.fromEntries(preloadEntries), dashDash: Object.fromEntries(dashEntries) }));',
  ].join('\n');
}

export function buildNodeEnvDriverSource(input: {
  surface: 'sandbox' | 'live';
  workerFile: string;
  childFile: string;
  nodeEnvCasesJson: string;
}): string {
  let evalCjs =
    'const { parentPort } = require("node:worker_threads"); let code = null; try { require("firebase/functions"); } catch (e) { code = e?.code ?? null; } parentPort.postMessage({ guarded: code === "PYRIC_LIVE_REFUSED", leakedForce: "PYRIC_SANDBOX_FORCE" in process.env });';
  if (input.surface === 'sandbox') {
    evalCjs =
      'const { parentPort } = require("node:worker_threads"); const a = require("firebase-admin/app"); parentPort.postMessage({ guarded: "ADMIN_APP_TARGET" in a, leakedForce: false });';
  }
  return [
    'import { fork, spawn } from "node:child_process";',
    'import { SHARE_ENV, Worker } from "node:worker_threads";',
    DRIVER_PREAMBLE,
    `const workerFile = ${JSON.stringify(input.workerFile)};`,
    `const childFile = ${JSON.stringify(input.childFile)};`,
    `const nodeEnvCases = ${input.nodeEnvCasesJson};`,
    `const evalCjs = ${JSON.stringify(evalCjs)};`,
    'process.env.NODE_ENV = "production";',
    'const nodeEnvEntries = await mapPool(nodeEnvCases, POOL_LIMIT, async (c) => {',
    '  let childEnv = process.env;',
    '  if (c.envKind === "custom") childEnv = { PATH: process.env.PATH, NODE_ENV: "production" };',
    '  if (c.carrier === "child-spawn") {',
    '    const r = await spawnNodeJson([childFile], childEnv, "CHILD ");',
    '    return [c.id, { guarded: Boolean(r.status === 0 && r.parsed?.guarded), leakedForce: Boolean(r.parsed?.leakedForce), detail: r.stderr }];',
    '  }',
    '  if (c.carrier === "child-fork") {',
    '    const r = await forkNodeJson(childFile, undefined, childEnv, "CHILD ");',
    '    return [c.id, { guarded: Boolean(r.status === 0 && r.parsed?.guarded), leakedForce: Boolean(r.parsed?.leakedForce), detail: r.stderr }];',
    '  }',
    '  const opts = {};',
    '  if (c.carrier === "worker-eval") opts.eval = true;',
    '  if (c.envKind === "null") opts.env = null;',
    '  else if (c.envKind === "share-env") opts.env = SHARE_ENV;',
    '  else if (c.envKind === "custom") opts.env = { PATH: process.env.PATH, NODE_ENV: "production" };',
    '  let target = workerFile;',
    '  if (c.carrier === "worker-eval") target = evalCjs;',
    '  const r = await runWorker(target, opts);',
    '  return [c.id, { guarded: Boolean(r.ok && r.msg?.guarded), leakedForce: Boolean(r.msg?.leakedForce), detail: r.err }];',
    '});',
    'console.log("NODE_ENV_REPORT " + JSON.stringify({ nodeEnvCases: Object.fromEntries(nodeEnvEntries) }));',
  ].join('\n');
}

export function buildAiModeDriverSource(input: {
  aiWorkerFile: string;
  aiChildFile: string;
  aiCasesJson: string;
}): string {
  return [
    'import { fork, spawn } from "node:child_process";',
    'import { SHARE_ENV, Worker } from "node:worker_threads";',
    DRIVER_PREAMBLE,
    `const aiWorkerFile = ${JSON.stringify(input.aiWorkerFile)};`,
    `const aiChildFile = ${JSON.stringify(input.aiChildFile)};`,
    `const aiCases = ${input.aiCasesJson};`,
    'const aiCasesOut = {};',
    'for (const mutationKind of ["mode-prod", "passthrough-only", "mode-prod-and-passthrough"]) {',
    '  const customWorkerEnv = { PATH: process.env.PATH };',
    '  if (mutationKind === "mode-prod") {',
    '    process.env.PYRIC_AI_MODE = "production";',
    '    delete process.env.PYRIC_AI_PASSTHROUGH;',
    '    customWorkerEnv.PYRIC_AI_MODE = "production";',
    '  } else if (mutationKind === "passthrough-only") {',
    '    delete process.env.PYRIC_AI_MODE;',
    '    process.env.PYRIC_AI_PASSTHROUGH = "1";',
    '    customWorkerEnv.PYRIC_AI_PASSTHROUGH = "1";',
    '  } else {',
    '    process.env.PYRIC_AI_MODE = "production";',
    '    process.env.PYRIC_AI_PASSTHROUGH = "1";',
    '    customWorkerEnv.PYRIC_AI_MODE = "production";',
    '    customWorkerEnv.PYRIC_AI_PASSTHROUGH = "1";',
    '  }',
    '  const group = aiCases.filter((entry) => entry.mutationKind === mutationKind);',
    '  await mapPool(group, POOL_LIMIT, async (c) => {',
    '    if (c.carrier === "in-process") {',
    '      const resolvedUrl = import.meta.resolve("firebase/ai");',
    '      await import("firebase/ai");',
    '      aiCasesOut[c.id] = { loadedRealAi: resolvedUrl.includes("/node_modules/firebase/") };',
    '      return;',
    '    }',
    '    if (c.carrier === "child-spawn") {',
    '      const r = await spawnNodeJson([aiChildFile], process.env, "AI_CHILD ");',
    '      aiCasesOut[c.id] = { loadedRealAi: Boolean(!r.parsed || r.parsed.loadedRealAi) };',
    '      return;',
    '    }',
    '    let opts = undefined;',
    '    if (c.carrier === "worker-share-env") opts = { env: SHARE_ENV };',
    '    else if (c.carrier === "worker-custom") opts = { env: customWorkerEnv };',
    '    const r = await runWorker(aiWorkerFile, opts);',
    '    aiCasesOut[c.id] = { loadedRealAi: Boolean(!r.ok || r.msg?.loadedRealAi) };',
    '  });',
    '}',
    'console.log("AI_REPORT " + JSON.stringify({ aiCases: aiCasesOut }));',
  ].join('\n');
}

export function buildRequireSpoofDriverSource(
  importerMap: Record<ImporterOriginKind, string>,
  spoofCasesJson: string,
): string {
  return [
    'import Module, { createRequire } from "node:module";',
    `const importerMap = ${JSON.stringify(importerMap)};`,
    `const allCases = ${spoofCasesJson};`,
    'let mode = "sandbox";',
    'if (process.env.PYRIC_AI_MODE === "production") mode = "production";',
    'let currentTarget = "";',
    'let capturedUrl = "";',
    'Module.registerHooks({',
    '  resolve(specifier, context, nextResolve) {',
    '    const res = nextResolve(specifier, context);',
    '    if (capturedUrl === "" && specifier === currentTarget) {',
    '      capturedUrl = res.url;',
    '    }',
    '    return res;',
    '  },',
    '});',
    'const cases = {};',
    'for (const entry of allCases.filter((c) => c.aiMode === mode)) {',
    '  const importerPath = importerMap[entry.importerKind];',
    '  currentTarget = entry.specifier;',
    '  capturedUrl = "";',
    '  try {',
    '    const req = createRequire(importerPath);',
    '    req(entry.specifier);',
    '    const resolvedUrl = capturedUrl.replaceAll("\\\\", "/");',
    '    if (resolvedUrl === "") {',
    '      cases[entry.id] = { loadedReal: false, code: "UNOBSERVED" };',
    '    } else {',
    '      const inRealSdk = resolvedUrl.includes("/node_modules/firebase/") || resolvedUrl.includes("/node_modules/@firebase/") || resolvedUrl.includes("/node_modules/firebase-admin/");',
    '      cases[entry.id] = { loadedReal: inRealSdk, code: null };',
    '    }',
    '  } catch (err) {',
    '    cases[entry.id] = { loadedReal: false, code: err?.code ?? "ERR" };',
    '  } finally {',
    '    currentTarget = "";',
    '  }',
    '}',
    'console.log("SPOOF_REPORT " + JSON.stringify({ cases }));',
  ].join('\n');
}
