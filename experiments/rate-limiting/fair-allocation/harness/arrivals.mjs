/**
 * Open-loop arrival generator.
 * Dispatches offers according to their precomputed schedule without waiting for
 * prior responses to complete (preventing coordinated omission). Bounds in-flight
 * sockets and records any generator saturation explicitly.
 */
export async function executeArrivalSchedule(offers, dispatchFn, { maxInFlight = 64 } = {}) {
    let inFlight = 0;
    let peakInFlight = 0;
    let generatorSaturatedCount = 0;
    const records = [];

    for (const offer of offers) {
        const plannedAtMs = offer.plannedAtMs;
        if (inFlight >= maxInFlight) {
            generatorSaturatedCount++;
            records.push({
                ...offer,
                sentAtMs: plannedAtMs,
                generatorSaturated: true,
                outcome: 'failed',
                reason: 'generator-saturated',
            });
            continue;
        }

        inFlight++;
        if (inFlight > peakInFlight) peakInFlight = inFlight;
        try {
            const res = await dispatchFn(offer);
            records.push({
                ...offer,
                sentAtMs: plannedAtMs,
                generatorSaturated: false,
                ...res,
            });
        } finally {
            inFlight--;
        }
    }

    return {
        totalOffered: offers.length,
        totalSent: offers.length - generatorSaturatedCount,
        generatorSaturatedCount,
        peakInFlight,
        records,
    };
}
