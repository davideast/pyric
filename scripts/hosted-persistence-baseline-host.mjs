import { monitorEventLoopDelay } from 'node:perf_hooks';

const delay = monitorEventLoopDelay({ resolution: 1 });
delay.enable();
const sample = setInterval(() => {
  process.stdout.write(`PYRIC_PERSISTENCE_METRICS ${JSON.stringify({
    at: Date.now(),
    eventLoopP95Ms: delay.percentile(95) / 1e6,
    eventLoopMaxMs: delay.max / 1e6,
    rss: process.memoryUsage().rss,
    usage: process.resourceUsage(),
  })}\n`);
  delay.reset();
}, 10_000);
sample.unref();
