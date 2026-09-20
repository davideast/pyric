export function onceAt(phase, point, action = () => { throw new Error('injected_backend_failure'); }) {
    let fired = false;
    return async (current, info) => {
        if (!fired && current === point && info.phase === phase) {
            fired = true;
            await action(info);
        }
    };
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
