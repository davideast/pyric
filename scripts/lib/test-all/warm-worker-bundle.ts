#!/usr/bin/env bun
// Builds the Vite plugin's SharedWorker bundle into its shared cache,
// ~/.pyric/vite-worker/<source hash>, before any CLI shard starts. The vite
// plugin tests in different shards would otherwise build it into that one
// directory at the same time, and with no lock around the write one shard can
// read another's half-written bundle ("SharedWorker bundle omitted its epoch
// placeholder", #1214). The lock itself is #1217.
import { createViteWorkerRuntime } from '../../../packages/cli/src/serve/vite-worker-runtime.ts';

const runtime = createViteWorkerRuntime();
await runtime.prepare();
console.log(`SharedWorker bundle ready in ${runtime.status().sdkDir}`);
