let functionsOutcome = 'loaded';
try {
  await import('firebase/functions');
} catch (error) {
  functionsOutcome = error?.code ?? error?.message ?? 'error';
}
console.log(
  `PROBE ${JSON.stringify({
    functionsOutcome,
    liveActive: globalThis[Symbol.for('pyric.register.live.active')] === true,
    sandboxActive: globalThis[Symbol.for('pyric.register.active')] === true,
  })}`,
);
