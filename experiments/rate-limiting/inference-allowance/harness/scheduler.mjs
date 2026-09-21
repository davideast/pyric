// Open-loop arrivals: a slow response never delays submission of the next request.
export async function scheduledRequests(schedule, submit, record) {
    const start = performance.now();
    return Promise.all(schedule.map(item => new Promise(resolve => setTimeout(resolve, item.atMs)).then(() => {
        record('arrival', { requestId: item.id, uid: item.uid, scheduledMs: item.atMs, actualMs: performance.now() - start });
        return submit(item);
    })));
}
