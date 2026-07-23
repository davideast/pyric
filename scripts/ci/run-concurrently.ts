#!/usr/bin/env bun
/**
 * Run labeled shell commands concurrently and fail if any of them fails.
 *
 *   bun scripts/ci/run-concurrently.ts "cli=bun run test:ci:cli" "gates=bun run ci:gates"
 *
 * Each argument is `label=command`; the command runs under `bash -c` with the
 * caller's environment. Output is streamed live with a `[label]` prefix so the
 * interleaved log stays attributable. Every stream runs to completion even
 * when another fails — a fast failure must not hide a second, slower one —
 * and the exit code is non-zero if any stream failed (fail-closed, matching
 * scripts/ci/required.ts).
 */

interface Stream {
  label: string;
  command: string;
}

export function parseStreams(args: string[]): Stream[] {
  if (args.length < 2) {
    throw new Error('run-concurrently needs at least two "label=command" arguments');
  }
  return args.map((arg) => {
    const separator = arg.indexOf('=');
    if (separator < 1 || separator === arg.length - 1) {
      throw new Error(`Expected "label=command", got: ${arg}`);
    }
    return { label: arg.slice(0, separator), command: arg.slice(separator + 1) };
  });
}

async function prefixLines(
  readable: ReadableStream<Uint8Array>,
  label: string,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of readable) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) console.log(`[${label}] ${line}`);
  }
  if (buffered) console.log(`[${label}] ${buffered}`);
}

async function runStream(stream: Stream): Promise<{ label: string; exitCode: number }> {
  const child = Bun.spawn(['bash', '-c', stream.command], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  await Promise.all([
    prefixLines(child.stdout, stream.label),
    prefixLines(child.stderr, stream.label),
  ]);
  return { label: stream.label, exitCode: await child.exited };
}

async function main(): Promise<void> {
  const streams = parseStreams(process.argv.slice(2));
  const startedAt = Date.now();
  const results = await Promise.all(streams.map(runStream));
  const failed = results.filter((result) => result.exitCode !== 0);
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  for (const result of results) {
    console.log(`[run-concurrently] ${result.label}: exit ${result.exitCode}`);
  }
  console.log(`[run-concurrently] ${streams.length} streams finished in ${seconds}s`);
  if (failed.length > 0) {
    console.error(`[run-concurrently] failed: ${failed.map((result) => result.label).join(', ')}`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
