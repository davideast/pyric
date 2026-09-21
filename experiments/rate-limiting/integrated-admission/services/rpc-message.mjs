/** @param {unknown} value @returns {Record<string, any> | null} */
export function rpcMessage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const message = Object.fromEntries(Object.entries(value));
    if (!['ready', 'rpc', 'reply', 'transaction-callback', 'command', 'command-result'].includes(message.type)) return null;
    return message;
}
