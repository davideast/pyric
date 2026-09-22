export function rpcMessage(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.type !== 'string') return null;
    return value;
}
