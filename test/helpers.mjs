// Shared test helpers for @zakkster/lite-crdt. No test() calls here; this file
// is imported by the suites and is excluded from the run by the explicit glob.

/** Deterministic PRNG (mulberry32) so convergence tests are reproducible. */
export function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Fisher-Yates shuffle into a new array using the supplied PRNG. */
export function shuffle(arr, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
    }
    return a;
}

/** A pick helper. */
export function pick(list, rand) {
    return list[Math.floor(rand() * list.length)];
}

/* ── Mock BroadcastChannel ──────────────────────────────────────────────────
 * Delivers messages to OTHER instances on the same channel name via a
 * microtask, structured-cloning the payload (matching real BroadcastChannel
 * semantics: no self-delivery, async, by-value).
 */
const registry = new Map(); // channelName -> Set<MockBroadcastChannel>

class MockBroadcastChannel {
    constructor(name) {
        this.name = name;
        this.onmessage = null;
        this._closed = false;
        let peers = registry.get(name);
        if (!peers) { peers = new Set(); registry.set(name, peers); }
        peers.add(this);
    }
    postMessage(data) {
        if (this._closed) return;
        const peers = registry.get(this.name);
        if (!peers) return;
        const payload = structuredClone(data);
        for (const peer of peers) {
            if (peer === this || peer._closed) continue;
            queueMicrotask(() => {
                if (!peer._closed && typeof peer.onmessage === "function") {
                    peer.onmessage({ data: structuredClone(payload) });
                }
            });
        }
    }
    close() {
        this._closed = true;
        const peers = registry.get(this.name);
        if (peers) peers.delete(this);
    }
}

export function installBroadcastChannel() {
    globalThis.BroadcastChannel = MockBroadcastChannel;
}
export function resetBroadcastChannel() {
    registry.clear();
    delete globalThis.BroadcastChannel;
}

/** Drain queued microtasks (BroadcastChannel deliveries). */
export async function flush(turns = 25) {
    for (let i = 0; i < turns; i++) await Promise.resolve();
}
