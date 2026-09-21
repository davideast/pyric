import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// A bounded IPC channel. Provider oracle control is only installed on the
// provider's parent pipe; the gateway receives only its public HTTP address.
export function peer(channel, handlers = {}, timeoutMs = 5000) {
    const pending = new Map();
    const send = message => { if (channel.connected) channel.send(message, () => {}); };
    const close = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('process-disconnected')); } pending.clear(); };
    channel.on('disconnect', close);
    channel.on('message', async message => {
        if (!message || typeof message.id !== 'string') return;
        if (message.type === 'reply') {
            const p = pending.get(message.id); if (!p) return;
            pending.delete(message.id); clearTimeout(p.timer);
            if (message.error) p.reject(new Error(message.error)); else p.resolve(message.value);
        } else if (message.type === 'call') {
            try {
                if (!Object.hasOwn(handlers, message.method)) throw new Error('unsupported-command');
                send({ type: 'reply', id: message.id, value: await handlers[message.method](message.args) });
            } catch { send({ type: 'reply', id: message.id, error: 'command-failed' }); }
        }
    });
    return { call(method, args = {}) {
        return new Promise((resolve, reject) => {
            if (!channel.connected) { reject(new Error('process-disconnected')); return; }
            const id = randomUUID();
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('command-timeout')); }, timeoutMs);
            pending.set(id, { resolve, reject, timer }); send({ type: 'call', id, method, args });
        });
    }, close };
}
export async function spawnPeer(url, handlers = {}) {
    const child = fork(fileURLToPath(url), [], { execPath: 'node', silent: true,
        // Fixture children do not inherit cloud credentials or SDK overrides.
        env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' } });
    child.stdout.resume(); child.stderr.resume();
    const exited = new Promise(resolve => child.once('close', resolve));
    const api = peer(child, handlers);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('process-start-timeout')); }, 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('process-exited-before-ready')); });
        child.on('message', msg => { if (msg && typeof msg === 'object' && 'type' in msg && msg.type === 'ready') { clearTimeout(timer); resolve(undefined); } });
    });
    return { ...api, pid: child.pid, async kill() { if (child.connected) child.kill('SIGKILL'); await exited; api.close(); } };
}
