/**
 * @zakkster/lite-crdt v1.1.0
 * --------------------------
 * Operational CRDTs for @zakkster/lite-store. Two convergent data types backed
 * by signal-reactive projections:
 *
 *   - LWW-Map   (doc.map)   last-write-wins register map; conflicts resolve by
 *                           a (lamport, replicaId) total order. Deletes are
 *                           timestamped tombstones that compete with writes.
 *   - OR-Set    (doc.array) observed-remove set keyed by a stable element id,
 *                           with a last-write-wins value register per id, so a
 *                           re-add of the same id edits the payload (add-wins
 *                           membership, LWW value) without disturbing order.
 *
 * Why lite-crdt owns the mutation API instead of observing a lite-store: an
 * op-based CRDT must capture intent at the mutation site (which element, which
 * tag). A transparent proxy only fires signals on write; you cannot reliably
 * reverse-engineer a causal op from that without lossy diffing. So lite-crdt is
 * the authoritative writer and uses lite-store strictly as a reactive read
 * model. You bind your UI to `collection.store` (a read-only projection) and
 * mutate through `.set()/.add()/.delete()`, which emit ops.
 *
 * Convergence: every op is commutative AND idempotent by construction, so a
 * transport may reorder and redeliver freely. LWW ops resolve by a total order
 * independent of arrival; OR ops are set insert/move keyed by globally-unique
 * tags. `getState()/mergeState()` give state-based sync to hydrate a late
 * joiner in a single payload rather than replaying an unbounded op log.
 *
 * Out of scope for v1: RGA / positional sequence + reorder, rich text, and
 * vector-clock tombstone GC (tombstones and removed-tags accumulate).
 *
 * Public surface: {@link createCRDTDoc}, {@link connectBroadcastChannel},
 * {@link CRDTError}.
 */

import { store, unwrap, snapshot as storeSnapshot, dispose as disposeStore } from "@zakkster/lite-store";
import { signal, dispose as disposeSignal, batch } from "@zakkster/lite-signal";

/* ─── Errors ──────────────────────────────────────────────────────────────── */

/**
 * Typed error for programmer mistakes: collection kind mismatch, malformed op,
 * writing through a read-only projection, or a missing element id.
 */
export class CRDTError extends Error {
    constructor(code, message, opts) {
        super(message, opts);
        this.name = "CRDTError";
        this.code = code;
    }
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

/** Generate a reasonably-unique replica id when the caller does not supply one. */
function genReplicaId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") return "r-" + c.randomUUID().slice(0, 8);
    return "r-" + Math.random().toString(36).slice(2, 10);
}

/**
 * True iff timestamp `a` strictly beats `b` under the (lamport, replicaId)
 * total order. Equal timestamps are the same write, so this returns false.
 */
function tsWins(al, ar, bl, br) {
    if (al !== bl) return al > bl;
    if (ar !== br) return ar > br;
    return false;
}

/** Compare two order keys passed as scalars (lamport, replicaId). Stable, total.
 *  Scalars rather than [l, r] tuples so ordering comparisons allocate nothing. */
function cmpOK(aL, aR, bL, bR) {
    if (aL !== bL) return aL < bL ? -1 : 1;
    if (aR !== bR) return aR < bR ? -1 : 1;
    return 0;
}

/**
 * Wrap a lite-store projection so the consumer can read (and stay reactive) but
 * cannot mutate it directly. Direct mutation would fire local UI reactivity
 * while bypassing the CRDT entirely — no op emitted, instant divergence. Reads
 * delegate to the underlying store proxy, preserving fine-grained tracking.
 */
const ARRAY_MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);

/**
 * The guard has to be DEEP. A one-level proxy only protects the top object: the
 * `get` trap hands back the child store proxy raw, so `map.store.cfg.theme = x`
 * sails straight through, mutates CRDT state, fires local UI reactivity and
 * emits NO op — the exact silent divergence the guard exists to prevent.
 *
 * Nested views are cached in a WeakMap so identity is stable across reads
 * (`s.cfg === s.cfg`) and a hot render loop re-wraps nothing.
 *
 * Returns `{ view, wrap }`: `wrap` is used by the read APIs (get/values/entries)
 * which would otherwise hand out mutable internals by another door.
 */
function readOnlyView(proj, isArray, label) {
    const cache = new WeakMap();
    const blow = () => {
        throw new CRDTError(
            "readonly",
            label + " is a read-only projection of CRDT state. Mutate through the document API " +
            "(.set()/.add()/.delete()), not the .store proxy.",
        );
    };
    const handler = {
        get(t, k) {
            // Array-ness is re-tested per level: a nested array needs its
            // mutators blocked just as much as the root does.
            if (typeof k === "string" && ARRAY_MUTATORS.has(k) && Array.isArray(t)) return blow;
            return wrap(Reflect.get(t, k)); // delegate to lite-store -> reactive read
        },
        set: blow,
        deleteProperty: blow,
        defineProperty: blow,
        setPrototypeOf() { return false; },
    };
    function wrap(v) {
        if (v === null || typeof v !== "object") return v;
        let w = cache.get(v);
        if (w === undefined) { w = new Proxy(v, handler); cache.set(v, w); }
        return w;
    }
    return { view: new Proxy(proj, handler), wrap };
}

/* ─── LWW-Map ─────────────────────────────────────────────────────────────── */

/**
 * @param {string} name
 * @param {{tick:()=>number, replicaId:string, emit:(op)=>void, changed:()=>void}} ctx
 */
function createLWWMap(name, ctx) {
    // key -> { l, r, del, v } : the winning register for the key (value or tombstone).
    const entries = new Map();
    const proj = store({});
    const { view: ro, wrap: roWrap } = readOnlyView(proj, false, "map('" + name + "').store");
    const rev = signal(0);
    const bump = () => rev.set(rev.peek() + 1);

    /** Apply an op to state + projection. Emits nothing. Returns true if the
     *  register changed (used by the doc only to decide whether to dedupe). */
    function apply(op) {
        // "__proto__" cannot be stored: `proj["__proto__"] = v` retargets the
        // projection's prototype instead of creating an own key, so the write
        // evaporates — get() returns {}, keys() never lists it, and getState()
        // drops it too. Ignoring it here (rather than throwing) keeps a remote
        // peer from being able to crash us with one crafted op; the LOCAL set()
        // path throws instead, so an app author finds out immediately.
        if (op.k === "__proto__") return false;
        const cur = entries.get(op.k);
        if (op.t === "set") {
            if (cur && !tsWins(op.l, op.r, cur.l, cur.r)) return false;
            const wasPresent = cur ? !cur.del : false;
            const prevV = wasPresent ? cur.v : undefined;
            // Mutate the existing register in place; only allocate on first touch.
            if (cur) { cur.l = op.l; cur.r = op.r; cur.del = false; cur.v = op.v; }
            else entries.set(op.k, { l: op.l, r: op.r, del: false, v: op.v });
            if (!wasPresent || !Object.is(prevV, op.v)) {
                proj[op.k] = op.v;
                bump();
                ctx.changed();
            }
            return true;
        }
        if (op.t === "del") {
            if (cur && !tsWins(op.l, op.r, cur.l, cur.r)) return false;
            const wasPresent = cur ? !cur.del : false;
            if (cur) { cur.l = op.l; cur.r = op.r; cur.del = true; cur.v = undefined; }
            else entries.set(op.k, { l: op.l, r: op.r, del: true, v: undefined });
            if (wasPresent) {
                delete proj[op.k];
                bump();
                ctx.changed();
            }
            return true;
        }
        throw new CRDTError("malformed_op", "LWW-Map cannot apply op type '" + op.t + "'");
    }

    function getState() {
        const e = {};
        for (const [k, rec] of entries) {
            e[k] = rec.del ? [rec.l, rec.r, 1] : [rec.l, rec.r, 0, rec.v];
        }
        return { kind: "map", entries: e };
    }

    function mergeState(s) {
        let touched = false;
        for (const k in s.entries) {
            const a = s.entries[k];
            const op = a[2]
                ? { t: "del", k, l: a[0], r: a[1] }
                : { t: "set", k, l: a[0], r: a[1], v: a[3] };
            if (apply(op)) touched = true;
        }
        return touched;
    }

    return {
        kind: "map",
        store: ro,
        get(k) { return roWrap(proj[k]); },
        has(k) { return k in proj; },
        get size() { rev(); return Object.keys(unwrap(proj)).length; },
        // SORTED, not insertion-ordered. Two replicas that converge on the same
        // key/value pairs still learn those keys in different orders, so raw
        // insertion order disagreed across replicas on 385/400 fuzz seeds — a
        // list rendered from entries() would sit in a different order per peer.
        // Sorting is what makes the public read APIs replica-independent.
        keys() { rev(); return Object.keys(unwrap(proj)).sort(); },
        values() { rev(); const t = unwrap(proj); return Object.keys(t).sort().map((k) => roWrap(t[k])); },
        entries() { rev(); const t = unwrap(proj); return Object.keys(t).sort().map((k) => [k, roWrap(t[k])]); },
        set(k, v) {
            if (typeof k !== "string") k = String(k);
            if (k === "__proto__") {
                throw new CRDTError("misconfigured",
                    "'__proto__' cannot be used as a map key — it would be silently dropped. Prefix or rename the key.");
            }
            if (ctx.recording) {
                const cur = entries.get(k);
                const wasPresent = cur ? !cur.del : false;
                ctx.record(wasPresent
                    ? { name, kind: "map", op: "set", k, v: cur.v }
                    : { name, kind: "map", op: "del", k });
            }
            const l = ctx.tick();
            const op = { t: "set", c: name, k, v, l, r: ctx.replicaId };
            apply(op);
            ctx.emit(op);
        },
        delete(k) {
            if (typeof k !== "string") k = String(k);
            if (k === "__proto__") {
                throw new CRDTError("misconfigured",
                    "'__proto__' cannot be used as a map key — it would be silently dropped. Prefix or rename the key.");
            }
            if (ctx.recording) {
                const cur = entries.get(k);
                if (cur && !cur.del) ctx.record({ name, kind: "map", op: "set", k, v: cur.v });
                // deleting an absent key is a visible no-op; nothing to undo.
            }
            const l = ctx.tick();
            const op = { t: "del", c: name, k, l, r: ctx.replicaId };
            apply(op);
            ctx.emit(op);
        },
        // Key order normalised for the same reason keys() is: a snapshot is what
        // callers hash, diff and assert on, and it should not depend on the order
        // this replica happened to hear about the keys.
        snapshot() {
            const raw = storeSnapshot(unwrap(proj));
            const out = {};
            const ks = Object.keys(raw).sort();
            for (let i = 0; i < ks.length; i++) out[ks[i]] = raw[ks[i]];
            return out;
        },
        _apply: apply,
        _getState: getState,
        _mergeState: mergeState,
        _dispose() { disposeStore(proj); disposeSignal(rev); entries.clear(); },
    };
}

/* ─── OR-Set ──────────────────────────────────────────────────────────────── */

/**
 * @param {string} name
 * @param {{identify?: (v:any)=>(string|number)}} opts
 * @param {{tick:()=>number, replicaId:string, emit:(op)=>void, changed:()=>void}} ctx
 */
function createORSet(name, opts, ctx) {
    const identify = (opts && opts.identify) || ((v) => (v == null ? undefined : v.id));

    const adds = new Map();      // id -> Map(tagKey -> lamport)  : live membership tags
    const removed = new Set();   // tagKeys tombstoned (observed-remove)
    const valueReg = new Map();  // id -> { l, r, v }             : LWW value register
    const order = [];            // ids in deterministic display order
    // Cached order key (min live tag) per member id, as scalars, so ordering
    // comparisons read numbers/strings and never allocate a tuple. Recomputed
    // only when an id's tag set changes, not on every comparison.
    const okL = new Map();       // id -> order-key lamport (number)
    const okR = new Map();       // id -> order-key replicaId (string)

    const proj = store([]);
    const { view: ro, wrap: roWrap } = readOnlyView(proj, true, "array('" + name + "').store");
    const rev = signal(0);
    const bump = () => rev.set(rev.peek() + 1);

    const idOf = (v) => {
        const id = identify(v);
        if (id == null) {
            throw new CRDTError(
                "misconfigured",
                "array('" + name + "') element has no id. Provide an `id` field or pass { identify } to doc.array().",
            );
        }
        return typeof id === "string" ? id : String(id);
    };
    const isMember = (id) => {
        const tags = adds.get(id);
        return tags !== undefined && tags.size > 0;
    };
    // Recompute and cache an id's order key (min live tag). The only place we
    // parse a replicaId out of a tagKey, and it runs just when the tag set
    // changes -- O(tags) per change, not per ordering comparison.
    const recomputeOK = (id) => {
        const tags = adds.get(id);
        if (tags === undefined || tags.size === 0) { okL.delete(id); okR.delete(id); return; }
        let bl = Infinity, br = "";
        for (const [tagKey, l] of tags) {
            // tagKey is `replicaId + "#" + tagCounter`. The counter is a number and
            // can never contain "#", but a replicaId can — "team#alice" and
            // "team#bob" both parsed to "team" under indexOf, collapsing two
            // distinct replicas onto one order key and inverting list order
            // between peers. Split on the LAST "#" so any replicaId is safe.
            const r = tagKey.slice(0, tagKey.lastIndexOf("#"));
            if (bl === Infinity || l < bl || (l === bl && r < br)) { bl = l; br = r; }
        }
        okL.set(id, bl); okR.set(id, br);
    };
    // Sorted insertion index for `id`, comparing cached scalar order keys.
    const indexFor = (id) => {
        const kl = okL.get(id), kr = okR.get(id);
        let i = 0;
        while (i < order.length && cmpOK(okL.get(order[i]), okR.get(order[i]), kl, kr) <= 0) i++;
        return i;
    };

    /**
     * Reconcile the projection for a single id after a state change, patching
     * the lite-store array minimally and firing reactivity only on a visible
     * change. `prevMember`/`prevL`/`prevR`/`prevVal` are captured before the
     * state mutation (and before recomputeOK).
     */
    function reconcile(id, prevMember, prevL, prevR, prevVal) {
        const nowMember = isMember(id);
        if (!prevMember && nowMember) {
            const pos = indexFor(id);
            order.splice(pos, 0, id);
            proj.splice(pos, 0, valueReg.get(id).v);
            bump(); ctx.changed();
            return;
        }
        if (prevMember && !nowMember) {
            const pos = order.indexOf(id);
            if (pos !== -1) { order.splice(pos, 1); proj.splice(pos, 1); bump(); ctx.changed(); }
            return;
        }
        if (prevMember && nowMember) {
            const nowVal = valueReg.get(id).v;
            if (cmpOK(prevL, prevR, okL.get(id), okR.get(id)) !== 0) {
                // a live tag was removed/added and shifted this id's order key
                const pos = order.indexOf(id);
                if (pos !== -1) { order.splice(pos, 1); proj.splice(pos, 1); }
                const np = indexFor(id);
                order.splice(np, 0, id);
                proj.splice(np, 0, nowVal);
                bump(); ctx.changed();
            } else if (!Object.is(prevVal, nowVal)) {
                const pos = order.indexOf(id);
                if (pos !== -1) { proj[pos] = nowVal; bump(); ctx.changed(); }
            }
        }
    }

    function setValue(id, l, r, v) {
        const cur = valueReg.get(id);
        if (cur) {
            if (!tsWins(l, r, cur.l, cur.r)) return false;
            cur.l = l; cur.r = r; cur.v = v;   // mutate in place; no per-write allocation
            return true;
        }
        valueReg.set(id, { l, r, v });
        return true;
    }

    function apply(op) {
        const id = op.id;
        const prevMember = isMember(id);
        const prevL = prevMember ? okL.get(id) : 0;
        const prevR = prevMember ? okR.get(id) : "";
        const prevVal = prevMember ? valueReg.get(id).v : undefined;

        if (op.t === "add") {
            const tagKey = op.r + "#" + op.n;
            if (!removed.has(tagKey)) {
                let tags = adds.get(id);
                if (tags === undefined) { tags = new Map(); adds.set(id, tags); }
                if (!tags.has(tagKey)) { tags.set(tagKey, op.l); recomputeOK(id); }
            }
            setValue(id, op.l, op.r, op.v);
            reconcile(id, prevMember, prevL, prevR, prevVal);
            return true;
        }
        if (op.t === "upd") {
            setValue(id, op.l, op.r, op.v);
            reconcile(id, prevMember, prevL, prevR, prevVal);
            return true;
        }
        if (op.t === "rm") {
            const tags = adds.get(id);
            let changed = false;
            for (let i = 0; i < op.g.length; i++) {
                const tagKey = op.g[i];
                removed.add(tagKey);
                if (tags !== undefined && tags.delete(tagKey)) changed = true;
            }
            if (changed) recomputeOK(id);
            reconcile(id, prevMember, prevL, prevR, prevVal);
            return true;
        }
        throw new CRDTError("malformed_op", "OR-Set cannot apply op type '" + op.t + "'");
    }

    function add(value) {
        const id = idOf(value);
        const member = isMember(id);
        if (ctx.recording) {
            if (member) {
                const prev = valueReg.get(id);
                ctx.record({ name, kind: "set", op: "upd", value: prev ? prev.v : undefined });
            } else {
                ctx.record({ name, kind: "set", op: "rmId", id });
            }
        }
        const l = ctx.tick();
        let op;
        if (member) {
            op = { t: "upd", c: name, id, v: value, l, r: ctx.replicaId };
        } else {
            op = { t: "add", c: name, id, n: ctx.tick.counter(), v: value, l, r: ctx.replicaId };
        }
        apply(op);
        ctx.emit(op);
        return id;
    }

    function removeById(id) {
        id = typeof id === "string" ? id : String(id);
        const tags = adds.get(id);
        if (tags === undefined || tags.size === 0) return false; // nothing observed to remove
        if (ctx.recording) {
            const prev = valueReg.get(id);
            ctx.record({ name, kind: "set", op: "add", value: prev ? prev.v : undefined });
        }
        const g = [];
        for (const tagKey of tags.keys()) g.push(tagKey);
        const l = ctx.tick();
        const op = { t: "rm", c: name, id, g, l, r: ctx.replicaId };
        apply(op);
        ctx.emit(op);
        return true;
    }

    function getState() {
        const a = {};
        for (const [id, tags] of adds) {
            if (tags.size === 0) continue;
            const m = {};
            for (const [tagKey, l] of tags) m[tagKey] = l;
            a[id] = m;
        }
        const vals = {};
        for (const [id, rec] of valueReg) vals[id] = [rec.l, rec.r, rec.v];
        return { kind: "set", adds: a, removed: Array.from(removed), values: vals };
    }

    function mergeState(s) {
        // Union removed tombstones first so resurrected tags are suppressed.
        for (let i = 0; i < s.removed.length; i++) removed.add(s.removed[i]);
        // Union add tags (minus tombstoned).
        for (const id in s.adds) {
            const incoming = s.adds[id];
            let tags = adds.get(id);
            if (tags === undefined) { tags = new Map(); adds.set(id, tags); }
            for (const tagKey in incoming) {
                if (!removed.has(tagKey)) tags.set(tagKey, incoming[tagKey]);
            }
        }
        // Prune any local tags now tombstoned by the merge.
        for (const [, tags] of adds) {
            for (const tagKey of tags.keys()) if (removed.has(tagKey)) tags.delete(tagKey);
        }
        // LWW-merge value registers.
        for (const id in s.values) {
            const a = s.values[id];
            setValue(id, a[0], a[1], a[2]);
        }
        rebuildProjection();
        return true;
    }

    /** Recompute order + projection array from scratch (used by mergeState). */
    function rebuildProjection() {
        const ids = [];
        for (const [id, tags] of adds) if (tags.size > 0) { recomputeOK(id); ids.push(id); }
        ids.sort((x, y) => cmpOK(okL.get(x), okR.get(x), okL.get(y), okR.get(y)));
        order.length = 0;
        for (let i = 0; i < ids.length; i++) order.push(ids[i]);
        proj.splice(0, proj.length, ...ids.map((id) => valueReg.get(id).v));
        bump();
        ctx.changed();
    }

    return {
        kind: "set",
        store: ro,
        has(v) { rev(); return isMember(idOf(v)); },
        hasId(id) { rev(); return isMember(typeof id === "string" ? id : String(id)); },
        get(id) {
            rev();
            id = typeof id === "string" ? id : String(id);
            // Wrapped for the same reason map.get() is: an unwrapped row is a
            // mutable internal, and writing through it changes CRDT state while
            // emitting NO op -- silent divergence by another door. `roWrap` was
            // already destructured here for this purpose but never applied.
            return isMember(id) ? roWrap(valueReg.get(id).v) : undefined;
        },
        get size() { rev(); return order.length; },
        values() { rev(); const t = unwrap(proj); const out = new Array(t.length); for (let i = 0; i < t.length; i++) out[i] = roWrap(t[i]); return out; },
        ids() { rev(); return order.slice(); },
        add,
        push: add,
        delete(v) { return removeById(idOf(v)); },
        deleteById: removeById,
        snapshot() { return storeSnapshot(unwrap(proj)); },
        _apply: apply,
        _getState: getState,
        _mergeState: mergeState,
        _dispose() { disposeStore(proj); disposeSignal(rev); adds.clear(); removed.clear(); valueReg.clear(); okL.clear(); okR.clear(); order.length = 0; },
    };
}

/* ─── PN-Counter ──────────────────────────────────────────────────────────── */

/**
 * Positive-Negative counter: two grow-only maps (per-replica cumulative
 * increments P and decrements N); the value is sum(P) - sum(N). Ops carry a
 * replica's NEW cumulative P (or N), and apply takes the max per replica -- so a
 * counter op is idempotent (re-max is a no-op) and commutative (max is), exactly
 * like the LWW and OR ops. No Lamport clock is needed: convergence is by max, not
 * by a total order. High-utility, trivially convergent: votes, likes, presence
 * counts.
 *
 * @param {string} name
 * @param {{replicaId:string, emit:(op)=>void, changed:()=>void, record:(d)=>void, recording:boolean}} ctx
 */
/**
 * `by | 0` silently corrupted every argument outside int32: inc(2.5) counted 2,
 * inc(1e10) WRAPPED to 1410065408, and inc(2**31), inc(Infinity) and inc(NaN)
 * all became silent no-ops. A counter that quietly miscounts is worse than one
 * that refuses. Non-positive `by` stays a documented no-op (llms.txt).
 * @private
 */
function counterStep(by, method) {
    if (by == null) return 1;
    if (typeof by !== "number" || !Number.isInteger(by)) {
        throw new CRDTError("misconfigured",
            method + "(by) requires an integer; got " + (typeof by === "number" ? by : typeof by) + ".");
    }
    if (by <= 0) return 0;                       // documented: non-positive is ignored
    if (!Number.isSafeInteger(by)) {
        throw new CRDTError("misconfigured", method + "(by) exceeds Number.MAX_SAFE_INTEGER.");
    }
    return by;
}

function createPNCounter(name, ctx) {
    const P = new Map();   // replicaId -> cumulative increments (grow-only)
    const N = new Map();   // replicaId -> cumulative decrements (grow-only)
    const val = signal(0);

    const recompute = () => {
        let s = 0;
        for (const v of P.values()) s += v;
        for (const v of N.values()) s -= v;
        return s;
    };
    const publish = () => {
        const t = recompute();
        if (t !== val.peek()) { val.set(t); ctx.changed(); }
    };

    function apply(op) {
        if (op.t === "cinc") {
            const cur = P.get(op.r) || 0;
            if (op.p > cur) { P.set(op.r, op.p); publish(); }
            return true;
        }
        if (op.t === "cdec") {
            const cur = N.get(op.r) || 0;
            if (op.n > cur) { N.set(op.r, op.n); publish(); }
            return true;
        }
        throw new CRDTError("malformed_op", "PN-Counter cannot apply op type '" + op.t + "'");
    }

    function getState() {
        const p = {}, n = {};
        for (const [r, v] of P) p[r] = v;
        for (const [r, v] of N) n[r] = v;
        return { kind: "counter", p, n };
    }

    function mergeState(s) {
        for (const r in s.p) { const v = s.p[r]; if (v > (P.get(r) || 0)) P.set(r, v); }
        for (const r in s.n) { const v = s.n[r]; if (v > (N.get(r) || 0)) N.set(r, v); }
        publish();
        return true;
    }

    return {
        kind: "counter",
        /** Reactive current value (subscribe). */
        value() { return val(); },
        /** Untracked current value. */
        peek() { return val.peek(); },
        get size() { return val(); },
        /** Increment by `by` (default 1; must be > 0). Emits a `cinc` op. */
        inc(by) {
            by = counterStep(by, "inc");
            if (by === 0) return;
            if (ctx.recording) ctx.record({ name, kind: "counter", op: "dec", by });
            const p = (P.get(ctx.replicaId) || 0) + by;
            const op = { t: "cinc", c: name, r: ctx.replicaId, p };
            apply(op);
            ctx.emit(op);
        },
        /** Decrement by `by` (default 1; must be > 0). Emits a `cdec` op. */
        dec(by) {
            by = counterStep(by, "dec");
            if (by === 0) return;
            if (ctx.recording) ctx.record({ name, kind: "counter", op: "inc", by });
            const n = (N.get(ctx.replicaId) || 0) + by;
            const op = { t: "cdec", c: name, r: ctx.replicaId, n };
            apply(op);
            ctx.emit(op);
        },
        snapshot() { return val.peek(); },
        _apply: apply,
        _getState: getState,
        _mergeState: mergeState,
        _dispose() { disposeSignal(val); P.clear(); N.clear(); },
    };
}

/* ─── Document ────────────────────────────────────────────────────────────── */

/**
 * Create a CRDT document: a namespace of convergent collections sharing one
 * Lamport clock and replica id.
 *
 * @param {{ replicaId?: string, clock?: number, onError?: (e:Error)=>void }} [options]
 */
export function createCRDTDoc(options) {
    const opts = options || {};
    const replicaId = opts.replicaId || genReplicaId();
    let lamport = opts.clock | 0;
    let disposed = false;

    const cols = new Map();          // name -> collection
    // Listener lists are plain arrays iterated by index, so dispatch allocates
    // no iterator. (Adding/removing a listener from inside its own dispatch is
    // not guaranteed to take effect within that same dispatch.)
    const opCbs = [];                // 'op'  : one call per single op
    const opsCbs = [];               // 'ops' : one call per batch (transact) or per single op ([op])
    const changeCbs = [];

    const onError = typeof opts.onError === "function" ? opts.onError : null;
    const report = (e) => { if (onError) { try { onError(e); } catch { /* ignore */ } } };

    // Tag counter: unique per replica within this doc, so OR-Set tags
    // (replicaId#counter) never collide for this writer.
    let tagCounter = 0;

    const tick = () => ++lamport;
    tick.counter = () => tagCounter++;

    // ── Transactions ──
    // transact(fn) buffers every op emitted during fn and flushes them as ONE
    // op-array payload (one 'ops' event => one network frame => one applyOps on
    // the far side), and coalesces the reactive `change` into a single fire.
    const txn = { depth: 0, ops: [], pendingChange: false };

    // ── Local undo/redo ──
    // Since ops are explicit, the inverse of a LOCAL edit is cheap to record.
    // `into` is the ring the next recorded inverse lands in ("undo" normally,
    // "redo" while replaying an undo, "undo" while replaying a redo). `busy` is
    // true during a replay, so a genuine new edit (busy=false) clears the redo
    // ring while an undo/redo edit does not.
    const undoDepth = opts.undoDepth == null ? 100 : (opts.undoDepth | 0);
    const history = { undo: [], redo: [], into: "undo", busy: false };

    function dispatchOp(op) {
        for (let i = 0; i < opCbs.length; i++) { try { opCbs[i](op); } catch (e) { report(e); } }
    }
    function dispatchOps(ops) {
        for (let i = 0; i < opsCbs.length; i++) { try { opsCbs[i](ops); } catch (e) { report(e); } }
    }
    function dispatchChange() {
        for (let i = 0; i < changeCbs.length; i++) { try { changeCbs[i](); } catch (e) { report(e); } }
    }

    const ctx = {
        replicaId,
        tick,
        recording: undoDepth > 0,
        emit(op) {
            if (disposed) return;
            if (txn.depth > 0) { txn.ops.push(op); return; }
            dispatchOp(op);
            if (opsCbs.length) dispatchOps([op]);   // a single emit is a 1-op batch to 'ops'
        },
        changed() {
            if (disposed) return;
            if (txn.depth > 0) { txn.pendingChange = true; return; }
            dispatchChange();
        },
        record(desc) {
            const ring = history.into === "redo" ? history.redo : history.undo;
            ring.push(desc);
            if (ring.length > undoDepth) ring.shift();      // bounded ring
            if (!history.busy) history.redo.length = 0;      // a new edit invalidates redo
        },
    };

    // Replay one recorded inverse by driving the matching PUBLIC mutator, so it
    // records ITS inverse into the opposite ring (via history.into). Auto-creates
    // the collection if it was disposed away (it will not have been, in practice).
    function runInverse(desc) {
        const col = getCollection(desc.name, desc.kind);
        if (desc.kind === "map") {
            if (desc.op === "set") col.set(desc.k, desc.v); else col.delete(desc.k);
        } else if (desc.kind === "set") {
            if (desc.op === "rmId") col.deleteById(desc.id); else col.add(desc.value);
        } else if (desc.kind === "counter") {
            if (desc.op === "inc") col.inc(desc.by); else col.dec(desc.by);
        }
    }

    function kindFromOpType(t) {
        if (t === "set" || t === "del") return "map";
        if (t === "add" || t === "upd" || t === "rm") return "set";
        if (t === "cinc" || t === "cdec") return "counter";
        throw new CRDTError("malformed_op", "unknown op type '" + t + "'");
    }

    function getCollection(name, kind, setOpts) {
        let col = cols.get(name);
        if (col === undefined) {
            col = kind === "map" ? createLWWMap(name, ctx)
                : kind === "counter" ? createPNCounter(name, ctx)
                : createORSet(name, setOpts || {}, ctx);
            cols.set(name, col);
            return col;
        }
        if (col.kind !== kind) {
            throw new CRDTError(
                "kind_mismatch",
                "collection '" + name + "' already exists as a " + col.kind + ", not a " + kind + ".",
            );
        }
        return col;
    }

    return {
        replicaId,
        clock() { return lamport; },

        map(name) {
            if (disposed) throw new CRDTError("misconfigured", "doc is disposed; cannot create or access collections");
            return getCollection(name, "map");
        },
        array(name, setOpts) {
            if (disposed) throw new CRDTError("misconfigured", "doc is disposed; cannot create or access collections");
            return getCollection(name, "set", setOpts);
        },
        counter(name) {
            if (disposed) throw new CRDTError("misconfigured", "doc is disposed; cannot create or access collections");
            return getCollection(name, "counter");
        },

        transact(fn) {
            if (disposed) return undefined;
            if (typeof fn !== "function") throw new CRDTError("misconfigured", "transact() requires a function");
            txn.depth++;
            let result;
            try {
                result = batch(fn);          // coalesce reactive propagation across the burst
            } finally {
                txn.depth--;
                if (txn.depth === 0) {
                    if (txn.ops.length) {
                        const ops = txn.ops;
                        txn.ops = [];            // swap out first: reentrancy-safe
                        for (let i = 0; i < ops.length; i++) dispatchOp(ops[i]);
                        if (opsCbs.length) dispatchOps(ops);
                    }
                    if (txn.pendingChange) { txn.pendingChange = false; dispatchChange(); }
                }
            }
            return result;
        },

        undo() {
            if (disposed || history.undo.length === 0) return false;
            const desc = history.undo.pop();
            history.busy = true; history.into = "redo";
            try { runInverse(desc); } finally { history.busy = false; history.into = "undo"; }
            return true;
        },
        redo() {
            if (disposed || history.redo.length === 0) return false;
            const desc = history.redo.pop();
            history.busy = true; history.into = "undo";
            try { runInverse(desc); } finally { history.busy = false; history.into = "undo"; }
            return true;
        },
        canUndo() { return history.undo.length > 0; },
        canRedo() { return history.redo.length > 0; },
        clearHistory() { history.undo.length = 0; history.redo.length = 0; },

        applyOp(op) {
            if (disposed) return;
            if (op == null || typeof op !== "object" || typeof op.t !== "string" || typeof op.c !== "string") {
                throw new CRDTError("malformed_op", "applyOp expects an op object with string `t` and `c`.");
            }
            const kind = kindFromOpType(op.t);
            // Lamport merge: a later local event will exceed any observed op.
            if (typeof op.l === "number" && op.l > lamport) lamport = op.l;
            const col = getCollection(op.c, kind);
            col._apply(op);
        },

        applyOps(ops) { for (let i = 0; i < ops.length; i++) this.applyOp(ops[i]); },

        getState() {
            const out = {};
            for (const [name, col] of cols) out[name] = col._getState();
            return { replicaId, clock: lamport, cols: out };
        },

        mergeState(state) {
            if (disposed || state == null || typeof state.cols !== "object") return;
            if (typeof state.clock === "number" && state.clock > lamport) lamport = state.clock;
            for (const name in state.cols) {
                const cs = state.cols[name];
                const kind = cs.kind === "map" || cs.kind === "counter" ? cs.kind : "set";
                const col = getCollection(name, kind);
                col._mergeState(cs);
            }
        },

        on(type, cb) {
            if (typeof cb !== "function") throw new CRDTError("misconfigured", "on() requires a callback");
            const list = type === "op" ? opCbs : type === "ops" ? opsCbs : type === "change" ? changeCbs : null;
            if (list === null) throw new CRDTError("misconfigured", "unknown event '" + type + "' (expected 'op', 'ops' or 'change')");
            list.push(cb);
            let live = true;
            return () => { if (live) { live = false; const i = list.indexOf(cb); if (i !== -1) list.splice(i, 1); } };
        },

        snapshot() {
            const out = {};
            for (const [name, col] of cols) out[name] = col.snapshot();
            return out;
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            for (const [, col] of cols) col._dispose();
            cols.clear();
            opCbs.length = 0;
            opsCbs.length = 0;
            changeCbs.length = 0;
            history.undo.length = 0;
            history.redo.length = 0;
        },
    };
}

/* ─── Optional transport: native BroadcastChannel (cross-tab) ─────────────── */

/**
 * Wire a document to a BroadcastChannel for zero-config cross-tab sync. Uses the
 * native BroadcastChannel (no dependency). Local ops are broadcast; received
 * ops are applied (idempotent, so redelivery is safe). On connect, the doc
 * requests current state and peers reply with `getState()`, hydrating a late
 * joiner without replaying an op log.
 *
 * @param {ReturnType<typeof createCRDTDoc>} doc
 * @param {string} channelName
 * @returns {{ dispose: () => void }}
 */
export function connectBroadcastChannel(doc, channelName) {
    const BC = globalThis.BroadcastChannel;
    if (typeof BC !== "function") {
        throw new CRDTError("misconfigured", "BroadcastChannel is not available in this environment.");
    }
    const self = doc.replicaId + ":" + Math.random().toString(36).slice(2, 8);
    const bc = new BC(channelName);

    // Subscribe to 'ops' (batched): a transact() burst crosses the wire as ONE
    // frame and one applyOps on the far side; a single edit is a 1-op batch.
    const offOps = doc.on("ops", (ops) => {
        try { bc.postMessage({ t: "ops", from: self, ops }); } catch { /* ignore */ }
    });

    bc.onmessage = (ev) => {
        const m = ev && ev.data;
        if (m == null || m.from === self) return;
        if (m.t === "ops") {
            doc.applyOps(m.ops);
        } else if (m.t === "op") {            // accept legacy single-op frames too
            doc.applyOp(m.op);
        } else if (m.t === "req") {
            bc.postMessage({ t: "state", from: self, to: m.from, state: doc.getState() });
        } else if (m.t === "state" && (m.to === self || m.to == null)) {
            doc.mergeState(m.state);
        }
    };

    // Ask existing tabs for current state.
    try { bc.postMessage({ t: "req", from: self }); } catch { /* ignore */ }

    return {
        dispose() {
            offOps();
            bc.onmessage = null;
            try { bc.close(); } catch { /* ignore */ }
        },
    };
}
