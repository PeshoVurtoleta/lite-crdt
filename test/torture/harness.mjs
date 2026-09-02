/**
 * test/torture/harness.mjs -- the shared spine for the lite-crdt torture gate.
 *
 * Provides: a seeded PRNG (replayable via TORTURE_SEED), a zero-alloc assert
 * (message built by a thunk, only on failure), the gc-profiler gate wrapper, a
 * canonical whole-doc snapshot, and validate(doc) -- the structural invariant.
 *
 * The lite-signal registry is pre-grown to a fixed capacity with
 * onCapacityExceeded:"throw": a registry that grows mid-measurement is the exact
 * allocation the gate exists to catch, hiding under the profiler's ArrayBuffer
 * blind spot. Docs are disposed so their signal nodes return to the pool and are
 * reused, never re-allocated.
 */
import { setDefaultRegistry, createRegistry } from "@zakkster/lite-signal";
import { measureOps, checkNoGc } from "@zakkster/lite-gc-profiler";

/* ── Seeded xorshift32 (must not be seeded with 0) ──────────────────────────── */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n;
})();

export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Float in [0,1) from a makePrng() instance. */
export function frac(next) { return next() / 4294967296; }

/* ── Zero-alloc assert: build the message only when it fails ─────────────────── */
export function die(msg) {
    process.stderr.write("torture: FAIL -- " + msg + "\n");
    process.exit(1);
}
export function check(cond, msgThunk) { if (!cond) die(msgThunk()); }

/* ── The signal registry the whole suite runs under ─────────────────────────── */
export function installRegistry(maxNodes = 1 << 18, maxLinks = 1 << 20) {
    setDefaultRegistry(createRegistry({ maxNodes, maxLinks, onCapacityExceeded: "throw" }));
}

/* ── The zero-alloc gate ────────────────────────────────────────────────────── */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/**
 * Measure `fn` (a zero-alloc `(i) => {}` body) over one settled window and gate
 * it against RULES. Returns { report, summary }. `stabilize:'deep'` is mandatory
 * for maxArrayBuffersGrowth -- ArrayBuffer backing stores live outside the V8
 * heap, invisible to a heapUsed gate.
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? Math.min(2000, opts.ops >> 3) : opts.warmup,
        stabilize: "deep",
    });
    return { report: checkNoGc(res.summary, RULES), summary: res.summary };
}

/* ── Canonical whole-doc snapshot ───────────────────────────────────────────── */
/**
 * doc.snapshot() is now replica-independent: the doc sorts its top-level
 * collection names and each per-collection snapshot sorts its own keys, so two
 * converged replicas emit byte-identical JSON (C-11 fixed in the library, v1.2.0).
 * canon() is therefore a raw JSON.stringify -- no top-level sort shim -- and the
 * call sites are unchanged.
 */
export function canon(doc) {
    return JSON.stringify(doc.snapshot());
}

/* ── validate(doc): the structural invariant ────────────────────────────────── */
/**
 * Throws on any structural break, off the public getState()/clock() surface:
 *   - the Lamport clock is finite;
 *   - every LWW register lamport is a finite number <= the clock, replicaId a string;
 *   - every counter P/N value is a finite, non-negative number;
 *   - every live OR-Set id (has tags) has a value register.
 * O(state); called between torture phases, never on a hot path. C-01, C-02,
 * C-03, C-07 (finiteness/ceiling) and C-15/C-18/C-19 (the value-register and
 * clock/lamport invariants) each violate one of these lines the moment they occur.
 */
export function validate(doc) {
    const clock = doc.clock();
    if (typeof clock !== "number" || !Number.isFinite(clock)) {
        throw new Error("validate: clock is not a finite number: " + clock);
    }
    const st = doc.getState();
    for (const name in st.cols) {
        const c = st.cols[name];
        if (c.kind === "map") {
            for (const k in c.entries) {
                const e = c.entries[k]; // [l, r, del] or [l, r, 0, v]
                if (typeof e[0] !== "number" || !Number.isFinite(e[0])) {
                    throw new Error("validate: map '" + name + "' key '" + k + "' lamport not finite: " + e[0]);
                }
                if (typeof e[1] !== "string") {
                    throw new Error("validate: map '" + name + "' key '" + k + "' replicaId not a string");
                }
                if (e[0] > clock) {
                    throw new Error("validate: map '" + name + "' key '" + k + "' lamport " + e[0] + " > clock " + clock);
                }
            }
        } else if (c.kind === "counter") {
            for (const r in c.p) {
                const v = c.p[r];
                if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
                    throw new Error("validate: counter '" + name + "' P[" + r + "] = " + v);
                }
            }
            for (const r in c.n) {
                const v = c.n[r];
                if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
                    throw new Error("validate: counter '" + name + "' N[" + r + "] = " + v);
                }
            }
        } else { // set
            for (const id in c.adds) {
                const tags = c.adds[id];
                let live = false;
                for (const _t in tags) { live = true; break; }
                if (live && !Object.hasOwn(c.values, id)) { // hasOwn: `in` walks the proto chain, so a proto-name id ("toString") would slip
                    throw new Error("validate: set '" + name + "' live id '" + id + "' has no value register");
                }
            }
            // Every value register's lamport must be finite and <= clock, replicaId a
            // string -- the map/counter branches check this, the set branch did not,
            // which is the torture blind spot that hid C-18's non-finite value lamport.
            for (const id in c.values) {
                const rec = c.values[id]; // [l, r, v]
                if (typeof rec[0] !== "number" || !Number.isFinite(rec[0])) {
                    throw new Error("validate: set '" + name + "' value '" + id + "' lamport not finite: " + rec[0]);
                }
                if (typeof rec[1] !== "string") {
                    throw new Error("validate: set '" + name + "' value '" + id + "' replicaId not a string");
                }
                if (rec[0] > clock) {
                    throw new Error("validate: set '" + name + "' value '" + id + "' lamport " + rec[0] + " > clock " + clock);
                }
            }
        }
    }
    return true;
}
