/**
 * Compute Jain's Fairness Index:
 * J(x_1, ..., x_n) = (sum(x_i))^2 / (n * sum(x_i^2))
 */
export function jainsFairnessIndex(values) {
    const n = values.length;
    if (n === 0) return { index: 1, n: 0, values: [], formula: '(sum(x_i))^2 / (n * sum(x_i^2))' };
    const sum = values.reduce((acc, x) => acc + x, 0);
    const sumSq = values.reduce((acc, x) => acc + x * x, 0);
    if (sumSq === 0) return { index: 1, n, values, formula: '(sum(x_i))^2 / (n * sum(x_i^2))' };
    const index = Number(((sum * sum) / (n * sumSq)).toFixed(4));
    return {
        index,
        n,
        values,
        formula: '(sum(x_i))^2 / (n * sum(x_i^2))',
    };
}

/**
 * Compute exact quantiles with explicit sample size N.
 */
export function quantiles(samples) {
    const sorted = [...samples].filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    const count = sorted.length;
    if (count === 0) return { count: 0, p50: null, p95: null, max: null };
    const pick = q => sorted[Math.max(0, Math.ceil(count * q) - 1)];
    return {
        count,
        p50: pick(0.5),
        p95: pick(0.95),
        max: pick(1.0),
    };
}

/**
 * Summarize per-user and per-cohort outcomes across all 12 accounting dimensions.
 */
export function summarizeVariantOutcomes(records, { backloggedUids = [], quietUids = [] } = {}) {
    const byUser = {};
    const ensure = uid => {
        if (!byUser[uid]) {
            byUser[uid] = {
                offered:           0,
                sent:              0,
                queueAdmitted:     0,
                executionAdmitted: 0,
                completed:         0,
                quotaDenied:       0,
                capacityRejected:  0,
                queueRejected:     0,
                expired:           0,
                cancelled:         0,
                failed:            0,
                unresolved:        0,
                queueWaitsMs:      [],
                endToEndMs:        [],
            };
        }
        return byUser[uid];
    };

    for (const rec of records) {
        const u = ensure(rec.uid);
        u.offered++;
        if (!rec.generatorSaturated) u.sent++;
        if (rec.queueAdmitted) u.queueAdmitted++;
        if (rec.executionAdmitted) u.executionAdmitted++;
        if (rec.terminalState === 'completed') u.completed++;
        if (rec.terminalState === 'quota-denied') u.quotaDenied++;
        if (rec.terminalState === 'capacity-rejected') u.capacityRejected++;
        if (rec.terminalState === 'queue-rejected') u.queueRejected++;
        if (rec.terminalState === 'expired') u.expired++;
        if (rec.terminalState === 'cancelled') u.cancelled++;
        if (rec.terminalState === 'failed') u.failed++;
        if (rec.terminalState === 'unresolved') u.unresolved++;

        if (Number.isFinite(rec.queueWaitMs)) u.queueWaitsMs.push(rec.queueWaitMs);
        if (Number.isFinite(rec.endToEndMs)) u.endToEndMs.push(rec.endToEndMs);
    }

    const userSummaries = Object.fromEntries(
        Object.entries(byUser).map(([uid, u]) => [
            uid,
            {
                offered:           u.offered,
                sent:              u.sent,
                queueAdmitted:     u.queueAdmitted,
                executionAdmitted: u.executionAdmitted,
                completed:         u.completed,
                quotaDenied:       u.quotaDenied,
                capacityRejected:  u.capacityRejected,
                queueRejected:     u.queueRejected,
                expired:           u.expired,
                cancelled:         u.cancelled,
                failed:            u.failed,
                unresolved:        u.unresolved,
                completionShare:   records.length > 0 ? Number((u.completed / records.length).toFixed(4)) : 0,
                fulfillmentRate:   u.offered > 0 ? Number((u.completed / u.offered).toFixed(4)) : 0,
                queueWaitMs:       quantiles(u.queueWaitsMs),
                endToEndMs:        quantiles(u.endToEndMs),
            },
        ]),
    );

    const backloggedCompletions = backloggedUids.map(uid => userSummaries[uid]?.completed ?? 0);
    const fairness = jainsFairnessIndex(backloggedCompletions);

    const quietFulfillment = Object.fromEntries(
        quietUids.map(uid => [
            uid,
            {
                offered:         userSummaries[uid]?.offered ?? 0,
                completed:       userSummaries[uid]?.completed ?? 0,
                fulfillmentRate: userSummaries[uid]?.fulfillmentRate ?? 0,
                queueWaitMs:     userSummaries[uid]?.queueWaitMs ?? quantiles([]),
            },
        ]),
    );

    return {
        totalRecords: records.length,
        users:        userSummaries,
        fairness: {
            cohort: backloggedUids,
            ...fairness,
        },
        quietCohort: quietFulfillment,
    };
}
