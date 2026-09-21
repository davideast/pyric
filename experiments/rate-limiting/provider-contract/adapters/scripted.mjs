export function scripted({ url, emit }) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('Fixture endpoint must be loopback');
    const json = async (route, options = {}) => { const r = await fetch(url + route, options); if (!r.ok) throw new Error('provider-http-error'); return r.json(); };
    const observation = async value => { const observed = { providerOperationId: null, observedAt: new Date().toISOString(), scope: 'one-provider-operation', usage: null, ...value }; await emit(observed); return observed; };
    return {
        async start({ key, signal }) {
            const info = await json('/start', { method: 'POST', signal, body: JSON.stringify({ key }) });
            await observation({ status: 'accepted', providerOperationId: info.providerOperationId, source: 'provider-response', strength: 'informational' });
            const response = await fetch(url + '/output/' + info.ticket, { signal });
            const completion = (async () => {
                try {
                    let pending = ''; const decoder = new TextDecoder();
                    for await (const bytes of response.body) {
                        pending += decoder.decode(bytes, { stream: true }); let boundary;
                        while ((boundary = pending.indexOf('\n')) >= 0) {
                            const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
                            if (line) await observation(JSON.parse(line));
                        }
                    }
                    await observation({ status: 'transport-closed', source: 'gateway-observation', strength: 'none' });
                } catch { await observation({ status: 'unknown', source: 'gateway-observation', strength: 'none' }); }
            })();
            return { ...info, completion };
        },
        requestStop: async id => observation(await json('/stop/' + id, { method: 'POST' })),
        observe: async id => observation(await json('/observe/' + id)),
    };
}
