// IPC is observation/control only. Workload requests always cross real loopback HTTP.
export function childRecorder(role) {
    let sequence = 0;
    const start = performance.now();
    process.on('disconnect', () => process.exit(1));
    return (kind, data = {}) => process.send?.({ type: 'event', kind, data: {
            ...data, role, processId: process.pid, localSequence: sequence++, localElapsedMs: performance.now() - start,
        } });
}
export function finishChild(message) {
    process.send(message, () => process.exit(0));
}
