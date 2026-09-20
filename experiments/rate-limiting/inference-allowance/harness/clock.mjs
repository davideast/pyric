export function controlledClock(start) {
    let time = start;
    return { now: () => time, advance: milliseconds => { time += milliseconds; } };
}
