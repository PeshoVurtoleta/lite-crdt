/**
 * @zakkster/lite-crdt v1.3.1
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
 * Tombstone compaction + delta sync (v1.3, decisions/0004): the doc tracks a
 * per-replica version vector (`doc.versionVector()`). `doc.compact(V)` is PURELY
 * LOCAL memory reclamation -- it drops the causally-stable tombstones (LWW
 * deletes, OR removed-tags and OR value registers for stable non-members) that
 * every replica in the supplied frontier V has already observed, emitting nothing
 * and adding no op type. `doc.getStateSince(V)` returns a partial `getState()`
 * carrying only what a peer at V has not yet seen -- consumed by the SAME
 * `mergeState` door. These are COLD: the version-vector max-update is the only
 * new per-op work and is O(1), zero-allocation, in place.
 *
 * Out of scope for v1: RGA / positional sequence + reorder and rich text.
 *
 * Public surface: {@link createCRDTDoc}, {@link connectBroadcastChannel},
 * {@link CRDTError}.
 */

import { store, unwrap, snapshot as storeSnapshot, dispose as disposeStore } from "@zakkster/lite-store";
import { signal, dispose as disposeSignal, batch } from "@zakkster/lite-signal";

/* --- Errors ---------------------------------------------------------------- */

/**
 * Typed error for programmer mistakes: collection kind mismatch, malformed op,
 * writing through a read-only projection, or a missing element id.
 */
/** Package version. Kept in three-place sync with package.json and CHANGELOG.md. */
export const VERSION = "1.3.1";

export class CRDTError extends Error {
    constructor(code, message, opts) {
        super(message, opts);
        this.name = "CRDTError";
        this.code = code;
    }
}

/* --- Helpers --------------------------------------------------------------- */

/**
 * The Web Crypto source, resolved ONCE at module load so genReplicaId stays a
 * synchronous read of a module-scope const. Resolution order:
 *   1. the Web Crypto global -- present unflagged in browsers and Node >= 19;
 *   2. the `node:crypto` `webcrypto` builtin -- the fallback for Node 18.x LTS,
 *      whose default runtime does NOT expose the unflagged `globalThis.crypto`
 *      (it landed in Node 19.0.0). A Node builtin is not a runtime dependency.
 * A browser has no `node:crypto`; the dynamic import rejects and is caught, so
 * step 1 stands. `webcrypto` exposes both `randomUUID` and `getRandomValues`.
 * This introduces top-level await -- valid ESM; every consumer imports the graph
 * (no CJS/require load of this file exists in the repo).
 */
let CRYPTO = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
    ? globalThis.crypto : null;
if (!CRYPTO && globalThis.process && globalThis.process.versions && globalThis.process.versions.node) {
    try { CRYPTO = (await import("node:crypto")).webcrypto; } catch { CRYPTO = null; }
}

/**
 * Generate a globally-unique replica id when the caller does not supply one.
 * COLD: runs once per createCRDTDoc, never on any apply/emit/add/rm hot path.
 * Fails closed -- absence of ANY crypto source (no Web Crypto global AND no
 * node:crypto, i.e. a genuinely crypto-less realm) is a misconfiguration, not a
 * licence to fall back to weak, collidable Math.random entropy. Both live paths
 * yield a 34-char id ("r-" + 32 hex). See decisions/0003 (C-14).
 */
function genReplicaId() {
    if (CRYPTO) {
        if (typeof CRYPTO.randomUUID === "function") return "r-" + CRYPTO.randomUUID().replace(/-/g, ""); // 122-bit UUIDv4 -> 32 hex
        if (typeof CRYPTO.getRandomValues === "function") {                                              // 128-bit fallback
            const b = CRYPTO.getRandomValues(new Uint8Array(16));
            let s = "r-";
            for (let i = 0; i < 16; i++) s += b[i].toString(16).padStart(2, "0");
            return s;
        }
    }
    throw new CRDTError(
        "misconfigured",
        "no crypto source (Web Crypto global or node:crypto) to mint a replica id; supply an explicit, globally-unique `replicaId` option."
    );
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
 * while bypassing the CRDT entirely -- no op emitted, instant divergence. Reads
 * delegate to the underlying store proxy, preserving fine-grained tracking.
 */
const ARRAY_MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);

/**
 * The guard has to be DEEP. A one-level proxy only protects the top object: the
 * `get` trap hands back the child store proxy raw, so `map.store.cfg.theme = x`
 * sails straight through, mutates CRDT state, fires local UI reactivity and
 * emits NO op -- the exact silent divergence the guard exists to prevent.
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

/* --- LWW-Map --------------------------------------------------------------- */

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
        // evaporates -- get() returns {}, keys() never lists it, and getState()
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
        // Keys SORTED so two converged replicas serialize byte-identically
        // regardless of the order they learned the keys (C-11). Cold path
        // (full-state sync), so the sort's allocation never touches a hot loop.
        // Object.create(null) for the uniform C-12 invariant: every getState
        // output keyed by caller-supplied data is prototype-free. A "__proto__"
        // map key cannot actually reach here (apply guards it at the door), but
        // the file keeps ONE rule for all serializers, not three.
        const e = Object.create(null);
        const ks = [...entries.keys()].sort();
        for (let i = 0; i < ks.length; i++) {
            const rec = entries.get(ks[i]);
            e[ks[i]] = rec.del ? [rec.l, rec.r, 1] : [rec.l, rec.r, 0, rec.v];
        }
        return { kind: "map", entries: e };
    }

    // Returns the MAX register lamport actually absorbed, so the doc can advance
    // its clock past it (C-12): a merged register with l=9 must not leave the
    // clock at 0, or the next local write emits l=1 and silently loses forever.
    function mergeState(s) {
        let maxL = 0;
        const src = s.entries;
        if (src === null || typeof src !== "object") return 0;
        for (const k in src) {
            // Read the register and its scalars EXACTLY ONCE, validate the
            // locals, and merge from those SAME locals (TOCTOU / C-11).
            const a = src[k];
            if (!Array.isArray(a)) { ctx.report(new CRDTError("malformed_state", "map dropped a malformed entry '" + k + "'.")); continue; }
            const l = a[0], r = a[1], del = a[2], v = a[3];
            if (typeof l !== "number" || !Number.isFinite(l) || l >= MAX_LAMPORT || typeof r !== "string") {
                ctx.report(new CRDTError("malformed_state", "map dropped entry '" + k + "' with a non-finite lamport or bad replicaId."));
                continue;
            }
            const op = del ? { t: "del", k, l, r } : { t: "set", k, l, r, v };
            apply(op);
            if (l > maxL) maxL = l;   // count every VALIDATED lamport, win or lose (symmetric with applyOp)
            ctx.observe(r, l);        // advance the doc's version vector for writer r (C4)
        }
        return maxL;
    }

    /**
     * COLD: drop causally-stable tombstones (decisions/0004). A LWW delete with
     * order (l, r) is stable -- droppable -- once every replica has observed it,
     * which the CONSERVATIVE global frontier `minAck = min(V.values())` proves:
     * `l <= minAck` implies every replica saw the delete AND any competing set
     * (with a strictly lower lamport) is itself stable (already delivered and
     * already lost to the tombstone), so no future op the tombstone was needed to
     * arbitrate can still arrive. Live registers (value writes) are NEVER dropped
     * here -- only tombstones. Returns the count reclaimed. O(entries).
     */
    function compact(minAck) {
        let n = 0;
        for (const [k, rec] of entries) {
            if (rec.del && rec.l <= minAck) { entries.delete(k); n++; }   // deleting the current key mid-iteration is safe on a Map
        }
        return n;
    }

    /**
     * COLD: the getState() shape filtered to registers a peer at version vector V
     * has NOT already seen -- `rec.l > V[rec.r]` for the writing replica r. A valid
     * (partial) map state the SAME mergeState door validates and unions. Cold path.
     */
    // V is the doc's already-validated, prototype-free version-vector SNAPSHOT
    // (snapshotVector, C-18) -- a static plain object, never the live untrusted V,
    // so each `V[rec.r]` here is a safe single read. rec.r is the register's own
    // writer (the deleter, for a tombstone) -- recoverable, so this per-writer
    // filter is sound for a per-peer delta.
    function getStateSince(V) {
        const e = Object.create(null);
        const ks = [...entries.keys()].sort();
        for (let i = 0; i < ks.length; i++) {
            const rec = entries.get(ks[i]);
            const sv = V[rec.r];
            const seen = typeof sv === "number" ? sv : 0;
            if (rec.l > seen) e[ks[i]] = rec.del ? [rec.l, rec.r, 1] : [rec.l, rec.r, 0, rec.v];
        }
        return { kind: "map", entries: e };
    }

    return {
        kind: "map",
        store: ro,
        get(k) { return roWrap(proj[k]); },
        has(k) { return k in proj; },
        get size() { rev(); return Object.keys(unwrap(proj)).length; },
        // SORTED, not insertion-ordered. Two replicas that converge on the same
        // key/value pairs still learn those keys in different orders, so raw
        // insertion order disagreed across replicas on 385/400 fuzz seeds -- a
        // list rendered from entries() would sit in a different order per peer.
        // Sorting is what makes the public read APIs replica-independent.
        keys() { rev(); return Object.keys(unwrap(proj)).sort(); },
        values() { rev(); const t = unwrap(proj); return Object.keys(t).sort().map((k) => roWrap(t[k])); },
        entries() { rev(); const t = unwrap(proj); return Object.keys(t).sort().map((k) => [k, roWrap(t[k])]); },
        set(k, v) {
            if (typeof k !== "string") k = String(k);
            if (k === "__proto__") {
                throw new CRDTError("misconfigured",
                    "'__proto__' cannot be used as a map key -- it would be silently dropped. Prefix or rename the key.");
            }
            // tick() BEFORE record(): tick can throw at the clock ceiling, and a
            // failed write must not leave a phantom inverse in the undo ring.
            const l = ctx.tick();
            if (ctx.recording) {
                const cur = entries.get(k);
                const wasPresent = cur ? !cur.del : false;
                ctx.record(wasPresent
                    ? { name, kind: "map", op: "set", k, v: cur.v }
                    : { name, kind: "map", op: "del", k });
            }
            const op = { t: "set", c: name, k, v, l, r: ctx.replicaId };
            apply(op);
            ctx.emit(op);
        },
        delete(k) {
            if (typeof k !== "string") k = String(k);
            if (k === "__proto__") {
                throw new CRDTError("misconfigured",
                    "'__proto__' cannot be used as a map key -- it would be silently dropped. Prefix or rename the key.");
            }
            // tick() BEFORE record(): a ceiling throw must not leave a phantom inverse.
            const l = ctx.tick();
            if (ctx.recording) {
                const cur = entries.get(k);
                if (cur && !cur.del) ctx.record({ name, kind: "map", op: "set", k, v: cur.v });
                // deleting an absent key is a visible no-op; nothing to undo.
            }
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
        _getStateSince: getStateSince,
        _mergeState: mergeState,
        _compact: compact,
        _dispose() { disposeStore(proj); disposeSignal(rev); entries.clear(); },
    };
}

/* --- OR-Set ---------------------------------------------------------------- */

/**
 * @param {string} name
 * @param {{identify?: (v:any)=>(string|number)}} opts
 * @param {{tick:()=>number, replicaId:string, emit:(op)=>void, changed:()=>void}} ctx
 */
function createORSet(name, opts, ctx) {
    const identify = (opts && opts.identify) || ((v) => (v == null ? undefined : v.id));

    const adds = new Map();      // id -> Map(tagKey -> lamport)  : live membership tags
    const removed = new Map();   // tagKey -> rmLamport           : tombstoned tags (observed-remove).
                                 // The lamport is the removing op's `l`; it is what a version-vector
                                 // frontier compares against to decide the tombstone is causally
                                 // stable (decisions/0004). SERIALIZES as the sorted key array only
                                 // (wire byte-compatible with <=1.2.x -- no lamport crosses the wire).
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
            // can never contain "#", but a replicaId can -- "team#alice" and
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
                // Record the removing op's lamport as the tombstone's stability key.
                // Any remover observed the tag before removing it, so op.l is strictly
                // above the tag's add lamport -- a frontier that covers op.l therefore
                // covers the add too (decisions/0004). Last-write-wins on re-remove is
                // fine: every stored value is some remover's l, all > the add lamport.
                removed.set(tagKey, op.l);
                if (tags !== undefined && tags.delete(tagKey)) changed = true;
            }
            if (changed) recomputeOK(id);
            reconcile(id, prevMember, prevL, prevR, prevVal);
            // Retention (C-10): once an id has no live tags, its adds entry is a
            // dead empty Map. Drop it AFTER recomputeOK + reconcile, both of which
            // read the id's order key -- so membership never outlives the id and no
            // read loses its key. valueReg is KEPT: it carries the max-lamport (l,r)
            // register, and dropping it would let a later lower-l add/upd win and
            // diverge (see decisions/0002). O(live ids), not O(ops).
            if (tags !== undefined && tags.size === 0) adds.delete(id);
            return true;
        }
        throw new CRDTError("malformed_op", "OR-Set cannot apply op type '" + op.t + "'");
    }

    function add(value) {
        const id = idOf(value);
        const member = isMember(id);
        // tick() BEFORE record(): a ceiling throw must not leave a phantom inverse.
        const l = ctx.tick();
        if (ctx.recording) {
            if (member) {
                const prev = valueReg.get(id);
                ctx.record({ name, kind: "set", op: "upd", value: prev ? prev.v : undefined });
            } else {
                ctx.record({ name, kind: "set", op: "rmId", id });
            }
        }
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
        // tick() BEFORE record(): a ceiling throw must not leave a phantom inverse.
        const l = ctx.tick();
        if (ctx.recording) {
            const prev = valueReg.get(id);
            ctx.record({ name, kind: "set", op: "add", value: prev ? prev.v : undefined });
        }
        const g = [];
        for (const tagKey of tags.keys()) g.push(tagKey);
        const op = { t: "rm", c: name, id, g, l, r: ctx.replicaId };
        apply(op);
        ctx.emit(op);
        return true;
    }

    function getState() {
        // Object.create(null) so a `__proto__` element id becomes an OWN key
        // instead of retargeting the object's prototype -- it round-trips through
        // getState -> mergeState intact, and it drops a crafted-`__proto__` throw
        // surface for free (C-12; consistent with the door's reject-and-continue
        // posture -- no new throw). Cold path (full-state sync).
        // ids and tag keys SORTED (and removed sorted) so two converged replicas
        // serialize byte-identically regardless of add order (C-11). Cold path.
        const a = Object.create(null);
        const addIds = [...adds.keys()].sort();
        for (let i = 0; i < addIds.length; i++) {
            const id = addIds[i];
            const tags = adds.get(id);
            if (tags.size === 0) continue;
            const m = Object.create(null);
            const tagKeys = [...tags.keys()].sort();
            for (let j = 0; j < tagKeys.length; j++) m[tagKeys[j]] = tags.get(tagKeys[j]);
            a[id] = m;
        }
        const vals = Object.create(null);
        const valIds = [...valueReg.keys()].sort();
        for (let i = 0; i < valIds.length; i++) {
            const id = valIds[i];
            const rec = valueReg.get(id);
            vals[id] = [rec.l, rec.r, rec.v];
        }
        // removed serializes as the SORTED KEY array (no lamport) -- byte-identical
        // to the <=1.2.x wire (C4 keeps `removed` a lamport-less array on the wire).
        return { kind: "set", adds: a, removed: [...removed.keys()].sort(), values: vals };
    }

    // Returns the MAX lamport absorbed across every live tag AND every value
    // register, so the doc advances its clock past it (C-12), symmetric with the
    // map path and applyOp.
    function mergeState(s) {
        let maxL = 0;
        // Every untrusted scalar below is read EXACTLY ONCE into a local,
        // validated, and merged from that same local (TOCTOU / C-11).
        // Union removed tombstones first so resurrected tags are suppressed.
        const rem = s.removed;
        if (Array.isArray(rem)) {
            // The wire carries `removed` as a lamport-less array (byte-compatible
            // with a 1.2.x peer). An absorbed tag of unknown provenance is stamped
            // MAX_LAMPORT-1 so it is NEVER treated as causally stable / dropped early
            // -- fail closed: unknown provenance == just-seen, not-yet-stable
            // (decisions/0004). A real `rm` op (apply, above) or a later merge that
            // carried a genuine lamport already put the true value here; do not
            // clobber it with the default.
            for (let i = 0; i < rem.length; i++) {
                const tk = rem[i];
                if (typeof tk === "string" && !removed.has(tk)) removed.set(tk, MAX_LAMPORT - 1);
            }
        }
        // Union add tags (minus tombstoned); validate each tag lamport at use.
        const sadds = s.adds;
        if (sadds !== null && typeof sadds === "object") {
            for (const id in sadds) {
                const incoming = sadds[id];
                if (incoming === null || typeof incoming !== "object") continue;
                let tags = adds.get(id);
                if (tags === undefined) { tags = new Map(); adds.set(id, tags); }
                for (const tagKey in incoming) {
                    const l = incoming[tagKey];
                    if (typeof l !== "number" || !Number.isFinite(l) || l >= MAX_LAMPORT) continue;
                    ctx.observe(tagKey.slice(0, tagKey.lastIndexOf("#")), l);   // advance vv for the tag's writer (C4)
                    if (!removed.has(tagKey)) { tags.set(tagKey, l); if (l > maxL) maxL = l; }
                }
            }
        }
        // Prune any local tags now tombstoned by the merge, and drop the adds
        // entry the moment it empties (C-10 retention): a union that created a
        // tag Map for an id whose every incoming tag was already tombstoned, or a
        // prune that removed the last live tag, must not leave a dead empty Map.
        for (const [id, tags] of adds) {
            for (const tagKey of tags.keys()) if (removed.has(tagKey)) tags.delete(tagKey);
            if (tags.size === 0) adds.delete(id);
        }
        // LWW-merge value registers; validate lamport/replicaId at use.
        const svals = s.values;
        if (svals !== null && typeof svals === "object") {
            for (const id in svals) {
                const a = svals[id];
                if (!Array.isArray(a)) continue;
                const l = a[0], r = a[1], v = a[2];
                if (typeof l !== "number" || !Number.isFinite(l) || l >= MAX_LAMPORT || typeof r !== "string") continue;
                setValue(id, l, r, v);
                if (l > maxL) maxL = l;
                ctx.observe(r, l);   // advance vv for the value register's writer (C4)
            }
        }
        // Consistency, checked against the ACTUAL merged Maps (immune to TOCTOU):
        // a live add-id with no value register would crash rebuildProjection off
        // an undefined `.v` (fail-open) and re-emit poison via getState. Drop its
        // tags and report so getState stays clean.
        for (const [id, tags] of adds) {
            if (tags.size > 0 && !valueReg.has(id)) {
                adds.delete(id);   // drop the whole entry (C-10): no empty Map left behind
                ctx.report(new CRDTError("malformed_state", "set dropped live add-id '" + id + "' with no value register."));
            }
        }
        rebuildProjection();
        return maxL;
    }

    /**
     * COLD: reclaim causally-stable state (decisions/0004) against the conservative
     * global frontier `minAck = min(V.values())`:
     *   - a `removed` tombstone with rmLamport `l` is dropped when `l <= minAck` --
     *     every replica has observed the removal (so no peer still holds the tag as
     *     a live add) AND the tag's earlier add is itself stable (`addL < l <= minAck`),
     *     so no delivery can reintroduce the tag;
     *   - a `valueReg` entry is dropped only for a NON-member id whose register write
     *     `l <= minAck` -- the C2-retained register finally goes, because a stable
     *     register cannot be beaten by any op that can still arrive (a peer that saw
     *     it emits only higher lamports; an older competing write is itself stable and
     *     already lost), and the id is not a live member, so no read needs its value.
     * Purely local: emits nothing, no op type, no wire change. Returns count reclaimed.
     */
    function compact(minAck) {
        let n = 0;
        for (const [tk, l] of removed) if (l <= minAck) { removed.delete(tk); n++; }
        for (const [id, rec] of valueReg) if (rec.l <= minAck && !isMember(id)) { valueReg.delete(id); n++; }
        return n;
    }

    /**
     * COLD: the getState() shape filtered to what a peer at version vector V has NOT
     * seen. A tag is included when its add lamport `l > V[adderR]` (adderR parsed off
     * the tagKey -- recoverable, so per-writer filtering is sound); a value register
     * when `rec.l > V[rec.r]` (rec.r is the register's own writer -- recoverable).
     *
     * `removed` is emitted IN FULL -- every tombstone, exactly as getState() does. It
     * MUST NOT be filtered against V: a tombstone is keyed by a tagKey that carries
     * only the tag's ADD-writer, never the REMOVE-writer, so V (a single peer's per-
     * writer frontier) cannot certify the peer has seen the removal. A peer caught up
     * on the add-writer but never told of the remove-writer would silently lose a
     * needed tombstone and RESURRECT the element (permanent divergence, no onError).
     * Shipping extra tombstones a peer already has is idempotent/harmless in the
     * union merge; omitting a needed one is fatal. (The conservative global `minAck`
     * frontier is valid ONLY for compact(), where V is the pointwise-min across ALL
     * replicas -- not here.) A valid (partial) set state the SAME mergeState door
     * validates and unions. Cold path. V is the doc's already-validated,
     * prototype-free version-vector SNAPSHOT (snapshotVector, C-18) -- a static plain
     * object, never the live untrusted V, so each `V[r]` below is a safe single read
     * and the delta cannot be made internally inconsistent by a live accessor.
     */
    function getStateSince(V) {
        const a = Object.create(null);
        const addIds = [...adds.keys()].sort();
        for (let i = 0; i < addIds.length; i++) {
            const id = addIds[i];
            const tags = adds.get(id);
            if (tags.size === 0) continue;
            let m = null;
            const tagKeys = [...tags.keys()].sort();
            for (let j = 0; j < tagKeys.length; j++) {
                const tk = tagKeys[j];
                const l = tags.get(tk);
                const r = tk.slice(0, tk.lastIndexOf("#"));   // the tag's ADD-writer -- recoverable, so per-writer filtering is sound
                const sv = V[r];
                const seen = typeof sv === "number" ? sv : 0;
                if (l > seen) { if (m === null) m = Object.create(null); m[tk] = l; }
            }
            if (m !== null) a[id] = m;
        }
        const rem = [...removed.keys()].sort();   // FULL tombstone set -- see above; NEVER filter by V
        const vals = Object.create(null);
        const valIds = [...valueReg.keys()].sort();
        for (let i = 0; i < valIds.length; i++) {
            const id = valIds[i];
            const rec = valueReg.get(id);
            const sv = V[rec.r];
            const seen = typeof sv === "number" ? sv : 0;
            if (rec.l > seen) vals[id] = [rec.l, rec.r, rec.v];
        }
        return { kind: "set", adds: a, removed: rem, values: vals };
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
        _getStateSince: getStateSince,
        _mergeState: mergeState,
        _compact: compact,
        // Test-only retention probe (C-10): live-map cardinalities that getState()
        // cannot reveal (it filters emptied tag Maps out). `adds` must track live
        // members, never O(ops); `valueReg` is deliberately retained per id.
        _retention() { return { adds: adds.size, valueReg: valueReg.size, removed: removed.size }; },
        _dispose() { disposeStore(proj); disposeSignal(rev); adds.clear(); removed.clear(); valueReg.clear(); okL.clear(); okR.clear(); order.length = 0; },
    };
}

/* --- PN-Counter ------------------------------------------------------------ */

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
        // Replica keys SORTED so two converged replicas serialize byte-identically
        // regardless of the order they learned each replica's cumulative (C-11).
        // Object.create(null) because the keys are caller-supplied replicaIds: a
        // "__proto__" replicaId (accepted by okOp, or an unvalidated local doc id)
        // would hit the `__proto__` setter on a plain {}, which silently DROPS a
        // number value -> the P/N entry vanishes from serialized state and the
        // peer diverges with zero onError (C-12). Cold path (full-state sync).
        const p = Object.create(null), n = Object.create(null);
        const pk = [...P.keys()].sort();
        for (let i = 0; i < pk.length; i++) p[pk[i]] = P.get(pk[i]);
        const nk = [...N.keys()].sort();
        for (let i = 0; i < nk.length; i++) n[nk[i]] = N.get(nk[i]);
        return { kind: "counter", p, n };
    }

    function mergeState(s) {
        // Read each cumulative EXACTLY ONCE, validate the local, merge from it
        // (TOCTOU / C-11): a live-accessor payload cannot validate benign then
        // hand max() a non-finite or negative value.
        const sp = s.p, sn = s.n;
        if (sp !== null && typeof sp === "object") {
            for (const r in sp) {
                const v = sp[r];
                if (typeof v !== "number" || !Number.isFinite(v) || v < 0) { ctx.report(new CRDTError("malformed_state", "counter dropped P[" + r + "].")); continue; }
                if (v > (P.get(r) || 0)) P.set(r, v);
            }
        }
        if (sn !== null && typeof sn === "object") {
            for (const r in sn) {
                const v = sn[r];
                if (typeof v !== "number" || !Number.isFinite(v) || v < 0) { ctx.report(new CRDTError("malformed_state", "counter dropped N[" + r + "].")); continue; }
                if (v > (N.get(r) || 0)) N.set(r, v);
            }
        }
        publish();
        return 0;   // PN-Counters carry no Lamport clock (converge by max); nothing to advance
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
        // PN-Counters carry no Lamport clock and no tombstones: nothing is ever
        // causally stale to reclaim, and a delta ships them FULL (P/N are small and
        // max-idempotent, so always-include is correct and simplest -- decisions/0004).
        _compact() { return 0; },
        _mergeState: mergeState,
        _dispose() { disposeSignal(val); P.clear(); N.clear(); },
    };
}

/* --- The remote-op validation door (reject-and-continue) ------------------- */

/**
 * Clock ceiling. At/above 2^53, `++lamport` is a float no-op and the (lamport,
 * replicaId) total order silently collapses to the replicaId tiebreak, so an
 * incoming `l` is bounded strictly below it (decisions/0001, C-07).
 */
const MAX_LAMPORT = 2 ** 53;

/**
 * Validate a remote op's convergence-driving fields IN PLACE -- scalar-only,
 * zero allocation, no temp object/array. The envelope (`t`/`c` are strings) is
 * already checked by applyOp before this runs; this is the choke point that
 * keeps another replica's bytes from poisoning the clock (C-01/C-02/C-07),
 * corrupting a counter (C-03), or freezing a register (C-04). Returns true iff
 * the op is safe to apply. Cold path (network receive), never the emit/apply
 * happy path.
 */
function okOp(op) {
    const t = op.t;
    // Counters carry no Lamport stamp: p / n must be a finite, non-negative
    // number and the replicaId a non-empty string.
    if (t === "cinc") return typeof op.p === "number" && Number.isFinite(op.p) && op.p >= 0 && typeof op.r === "string" && op.r.length > 0;
    if (t === "cdec") return typeof op.n === "number" && Number.isFinite(op.n) && op.n >= 0 && typeof op.r === "string" && op.r.length > 0;
    // Every other op type carries a Lamport stamp (l) and a replicaId (r).
    const l = op.l;
    if (typeof l !== "number" || !Number.isFinite(l) || l >= MAX_LAMPORT) return false;
    if (typeof op.r !== "string" || op.r.length === 0) return false;
    if (t === "set" || t === "del") return typeof op.k === "string";
    if (t === "add") return typeof op.id === "string" && typeof op.n === "number";
    if (t === "upd") return typeof op.id === "string";
    if (t === "rm") {
        const g = op.g;
        if (!Array.isArray(g) || typeof op.id !== "string") return false;
        for (let i = 0; i < g.length; i++) if (typeof g[i] !== "string") return false;
        return true;
    }
    return false;
}

/**
 * Cheap top-level container-shape check for a state-based collection payload:
 * the containers each _mergeState will iterate are the right kind (objects, and
 * an array for `removed`), so a wholly malformed collection is rejected and
 * reported at the door (C-06). It DELIBERATELY does not deep-validate scalars:
 * that is done at USE inside each _mergeState, which reads every untrusted
 * scalar exactly once and merges from that same local. A validate-here-then-
 * re-read-at-use split is a TOCTOU -- a live-accessor payload (getter/Proxy)
 * would return a benign record to the validator and a poison one to the merge
 * (C-11). So scalar validation lives at the single point of use, never here.
 * Cold path -- runs once per collection on a full-state sync.
 */
function okState(cs, kind) {
    if (kind === "map") {
        return cs.entries !== null && typeof cs.entries === "object";
    }
    if (kind === "counter") {
        return cs.p !== null && typeof cs.p === "object" && cs.n !== null && typeof cs.n === "object";
    }
    // set
    return cs.adds !== null && typeof cs.adds === "object" &&
        Array.isArray(cs.removed) &&
        cs.values !== null && typeof cs.values === "object";
}

/**
 * Read an untrusted version vector (a plain `{ replicaId: lamport }` object, e.g.
 * one that arrived off the wire for a delta request) ONCE into a validated,
 * prototype-free snapshot -- the SAME single-read-into-validated-scratch discipline
 * decisions/0001 (C-18) established for the op/state door. Each field of V is read
 * EXACTLY ONCE, validated inline (a finite, non-negative lamport strictly below the
 * clock ceiling), and copied into the snapshot; compact()/getStateSince() then
 * consult ONLY the snapshot, never the live V again. This closes the TOCTOU a
 * live-accessor V (a getter or Proxy) would otherwise open: a second, independent
 * traversal (validate-here-then-re-read-at-use) would let V return a benign value
 * to the validator and a poison one to `minAckOf` / the `V[r]` filters, dropping a
 * tombstone it must not. Fail closed: a malformed vector (not an object, an array,
 * a `__proto__` key, or any non-finite/negative/over-ceiling value) yields `null`
 * -- the whole vector is rejected, never a partial. Cold path -- runs once per
 * compact()/getStateSince() call.
 */
function snapshotVector(V) {
    if (V === null || typeof V !== "object" || Array.isArray(V)) return null;   // a vector is a { replicaId: lamport } map, never an array
    const out = Object.create(null);
    for (const r in V) {
        if (r === "__proto__") return null;                 // fail closed: a __proto__ replicaId is garbage/attack
        const n = V[r];                                     // read each field EXACTLY ONCE (C-18)
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n >= MAX_LAMPORT) return null;
        out[r] = n;                                         // freeze the validated value into the snapshot
    }
    return out;
}

/**
 * The CONSERVATIVE global compaction frontier: the pointwise-min lamport across a
 * version-vector SNAPSHOT (already validated + frozen by snapshotVector, so every
 * value here is a plain finite number -- no live re-read). `min(V.values())`, or 0
 * when V is empty -- an empty
 * frontier acknowledges nothing, so nothing is stable (`l <= 0` is never true for a
 * real lamport). Dropping state at `l <= minAck` is SAFE because minAck <= V[r] for
 * every r, so it implies the per-replica seen-by-all condition for every writer at
 * once (decisions/0004). Cold path.
 */
function minAckOf(V) {
    let m = Infinity, any = false;
    for (const r in V) { const n = V[r]; if (typeof n === "number") { any = true; if (n < m) m = n; } }
    return (any && Number.isFinite(m)) ? m : 0;
}

/* --- Document -------------------------------------------------------------- */

/**
 * Create a CRDT document: a namespace of convergent collections sharing one
 * Lamport clock and replica id.
 *
 * @param {{ replicaId?: string, clock?: number, onError?: (e:Error)=>void }} [options]
 */
export function createCRDTDoc(options) {
    const opts = options || {};
    // C-20: validate a caller-supplied replicaId at the LOCAL boundary, mirroring
    // the remote door okOp (`typeof op.r === "string" && op.r.length > 0`). Without
    // this, a non-string but truthy id was accepted locally yet every op it emits
    // carries a non-string `r` that EVERY peer's door drops -- a one-way silent
    // divergence with no onError on this side. A falsy id ("" / 0) silently fell
    // through `|| genReplicaId()` and got auto-minted, overriding the caller. Fail
    // closed: only an OMITTED id (undefined) auto-mints; any provided id must be a
    // non-empty string. No charset cap (a tagKey `r#n` splits on the LAST "#", so
    // "team#alice" is valid) and no length cap (the door imposes none; a stricter
    // local rule would reject an explicit id a peer legitimately emits). Cold path:
    // once per doc, never on any hot body. See decisions/0005 (and 0003 / C-14).
    const ridOpt = opts.replicaId;
    let replicaId;
    if (ridOpt === undefined) {
        replicaId = genReplicaId();
    } else if (typeof ridOpt === "string" && ridOpt.length > 0) {
        replicaId = ridOpt;
    } else {
        throw new CRDTError(
            "misconfigured",
            "`replicaId` must be a non-empty string when provided (it stamps every op's `r` and every OR-Set tag `r#n`, and drives the (lamport, replicaId) total order); a non-string or empty id emits ops every peer's door drops. Omit `replicaId` to auto-mint one.",
        );
    }
    let lamport = opts.clock | 0;
    let disposed = false;

    const cols = new Map();          // name -> collection
    // Pre-allocated scratch op for the receive door. applyOp copies each field of
    // an untrusted op into it EXACTLY ONCE, then validates + clock-merges +
    // applies from the scratch ONLY -- so a live-accessor op (getter/Proxy) cannot
    // pass validation then be re-read with poison at use (TOCTOU / C-11). Zero
    // per-op allocation (one scratch per doc, reused; keeps the T6 gate). Reused
    // across reentrant applyOp because every collection's apply() reads all its op
    // fields BEFORE it fires ctx.changed(), so a nested applyOp cannot clobber a
    // field an outer apply() has yet to read. The local mutation API builds its
    // own plain ops and never touches this scratch.
    const scratchOp = { t: "", c: "", k: undefined, id: undefined, l: 0, r: "", v: undefined, n: undefined, p: undefined, g: undefined };
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

    // Version vector: replicaId -> max lamport this doc has observed from that
    // writer (C4). It is the frontier compact()/getStateSince() reason about. The
    // ONLY new per-op work is `observe`: an O(1), zero-allocation in-place max on an
    // ALREADY-VALIDATED (r, l) -- the Map grows only on a genuinely new replicaId
    // (bounded by replica count, not op count), so steady state allocates nothing
    // (the T6 gate). Counters carry no lamport (l is undefined) and never touch vv.
    const vv = new Map();
    const observe = (r, l) => { if (typeof l === "number" && l > (vv.get(r) || 0)) vv.set(r, l); };

    // Fail closed at the clock ceiling: rather than silently saturate (at/above
    // 2^53 `++lamport` is a float no-op and causal order collapses, C-07), throw
    // so the caller learns the doc can no longer order writes.
    const tick = () => {
        if (lamport >= MAX_LAMPORT - 2) {
            throw new CRDTError("clock_ceiling",
                "Lamport clock reached the 2^53 ceiling; the doc can no longer order writes.");
        }
        lamport++;
        observe(replicaId, lamport);   // a local write advances this replica's own vv entry
        return lamport;
    };
    tick.counter = () => tagCounter++;

    // -- Transactions --
    // transact(fn) buffers every op emitted during fn and flushes them as ONE
    // op-array payload (one 'ops' event => one network frame => one applyOps on
    // the far side), and coalesces the reactive `change` into a single fire.
    const txn = { depth: 0, ops: [], pendingChange: false };

    // -- Local undo/redo --
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
        observe,  // collections advance the version vector for every register/tag lamport they absorb (C4)
        report,   // collections route a dropped-at-use malformed state entry here
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
            if (op == null || typeof op !== "object") {
                throw new CRDTError("malformed_op", "applyOp expects an op object with string `t` and `c`.");
            }
            // Freeze the untrusted op into the doc-owned scratch, reading each
            // field EXACTLY ONCE (TOCTOU / C-11). Every check + the clock merge +
            // _apply below read ONLY `s`, so a live-accessor op cannot validate
            // benign then apply poison. Zero allocation (scratch is reused).
            const s = scratchOp;
            s.t = op.t; s.c = op.c; s.k = op.k; s.id = op.id;
            s.l = op.l; s.r = op.r; s.v = op.v; s.n = op.n; s.p = op.p; s.g = op.g;
            if (typeof s.t !== "string" || typeof s.c !== "string") {
                throw new CRDTError("malformed_op", "applyOp expects an op object with string `t` and `c`.");
            }
            const kind = kindFromOpType(s.t);
            // The door (reject-and-continue, decisions/0001): a kind-mismatched
            // collection OR a malformed payload is DROPPED and reported to
            // onError -- never applied, never thrown out of applyOps. Runs before
            // the clock merge so a poisoned `l` cannot touch the clock.
            const existing = cols.get(s.c);
            if ((existing !== undefined && existing.kind !== kind) || !okOp(s)) {
                report(new CRDTError("malformed_op",
                    "dropped a malformed or kind-mismatched '" + s.t + "' op for collection '" + s.c + "'."));
                return;
            }
            // Lamport merge: a later local event will exceed any observed op.
            if (typeof s.l === "number" && s.l > lamport) lamport = s.l;
            // Version-vector max-update (C4): the ONLY new per-op work. In place,
            // O(1), zero-allocation on the validated scratch fields (a Map.set of an
            // existing replicaId key allocates nothing; a brand-new writer grows the
            // Map once, bounded by replica count). Counter ops carry no `l`
            // (s.l undefined), so `observe` skips them -- vv tracks lamport only.
            observe(s.r, s.l);
            const col = getCollection(s.c, kind);
            col._apply(s);
        },

        // applyOps is RESILIENT (decisions/0001): the transport-safe batch path a
        // custom transport uses. A single applyOp stays STRICT (a non-op envelope
        // or unknown op type throws), but a batch must never throw on one bad
        // frame -- the throw is caught, reported, and the batch continues so every
        // good op still applies. okOp failures + kind-mismatch already
        // report-and-continue inside applyOp; this catches the two throw paths.
        applyOps(ops) {
            for (let i = 0; i < ops.length; i++) {
                try { this.applyOp(ops[i]); } catch (e) { report(e); }
            }
        },

        getState() {
            // Cold path (called between phases on a full-state sync, never on the
            // apply/emit/rm hot loop), so the sort's allocation is acceptable and
            // buys replica-independent output. Names SORTED and `out` built over
            // Object.create(null): two converged replicas emit byte-identical JSON
            // regardless of collection-creation order, and a `__proto__`
            // COLLECTION name round-trips as an OWN key rather than clobbering the
            // prototype (C-11 / C-12).
            const out = Object.create(null);
            const names = [...cols.keys()].sort();
            for (let i = 0; i < names.length; i++) out[names[i]] = cols.get(names[i])._getState();
            return { replicaId, clock: lamport, cols: out };
        },

        mergeState(state) {
            if (disposed || state == null || typeof state !== "object" || state.cols === null || typeof state.cols !== "object") return;
            // Bound the clock merge exactly like the op door: a non-finite or
            // over-ceiling clock in an untrusted payload must not poison ours.
            if (typeof state.clock === "number" && Number.isFinite(state.clock) && state.clock < MAX_LAMPORT && state.clock > lamport) {
                lamport = state.clock;
            }
            for (const name in state.cols) {
                const cs = state.cols[name];
                // Fail closed on a malformed collection: skip and report, never a
                // raw TypeError and never a silent partial apply (C-06).
                if (cs === null || typeof cs !== "object" || (cs.kind !== "map" && cs.kind !== "counter" && cs.kind !== "set")) {
                    report(new CRDTError("malformed_state", "dropped a malformed collection '" + name + "'."));
                    continue;
                }
                const kind = cs.kind;
                const existing = cols.get(name);
                if ((existing !== undefined && existing.kind !== kind) || !okState(cs, kind)) {
                    report(new CRDTError("malformed_state", "dropped a malformed or kind-mismatched collection '" + name + "'."));
                    continue;
                }
                const col = getCollection(name, kind);
                // Advance the clock past every lamport this merge absorbed (C-12),
                // symmetric with applyOp's `s.l > lamport` bump -- otherwise a
                // merged register with l=9 leaves the clock behind it and the next
                // local write emits a lower l and silently loses forever. Every
                // accepted lamport is < MAX_LAMPORT (validated at use), so the
                // clock stays representable; the guard is belt-and-suspenders.
                const maxSeen = col._mergeState(cs);
                if (typeof maxSeen === "number" && maxSeen > lamport && maxSeen < MAX_LAMPORT) lamport = maxSeen;
            }
        },

        // -- Tombstone compaction + delta sync (C4, decisions/0004) --

        // The doc's version vector: replicaId -> max lamport observed from that
        // writer. A prototype-free, JSON-serializable snapshot COPY (safe to send a
        // peer, who replies with getStateSince(thisVector)). Cold path.
        versionVector() {
            const out = Object.create(null);
            for (const [r, l] of vv) out[r] = l;
            return out;
        },

        // Purely-local memory reclamation: drop every causally-stable tombstone
        // (LWW delete, OR removed-tag, OR value register for a stable non-member)
        // that every replica in the frontier V has already observed. Emits NOTHING,
        // introduces no op type, changes no wire format -- it only forgets state no
        // future op can still need (decisions/0004). V MUST be the pointwise-min
        // version vector across ALL replicas (each replica's versionVector(), mins'd
        // per key); supplying a frontier ahead of some lagging replica would drop a
        // tombstone that replica's concurrent op still needs to lose to -> silent
        // resurrection. A malformed V is reported to onError and reclaims nothing
        // (fail closed, never throws). Returns the count of entries reclaimed.
        // V is UNTRUSTED: it is read ONCE into a validated, prototype-free snapshot
        // (snapshotVector, the C-18 single-read discipline), and everything below --
        // minAckOf and each collection's _compact -- consults ONLY that snapshot, so
        // a live-accessor V cannot validate benign then re-read as poison (TOCTOU).
        compact(V) {
            if (disposed) return 0;
            const vsnap = snapshotVector(V);
            if (vsnap === null) {
                report(new CRDTError("malformed_state", "compact() dropped a malformed version vector."));
                return 0;
            }
            const minAck = minAckOf(vsnap);
            let reclaimed = 0;
            for (const [, col] of cols) reclaimed += col._compact(minAck);
            return reclaimed;
        },

        // The getState() shape filtered to just what a peer at version vector V has
        // NOT yet seen (per-writer `l > V[r]`; counters ship full -- they are small
        // and max-idempotent). A valid (partial) state consumed by the SAME
        // mergeState door, so `peerAtV.mergeState(this.getStateSince(V))` converges
        // the peer to this replica in one delta frame instead of a full state dump.
        // A malformed V fails closed to a FULL getState() (a superset is always safe)
        // and is reported. Cold path. V is UNTRUSTED: read ONCE into a validated
        // snapshot (snapshotVector, C-18); every per-record `V[r]` filter below reads
        // that snapshot, never the live V, so the delta cannot be made internally
        // inconsistent by a live-accessor V.
        getStateSince(V) {
            const vsnap = snapshotVector(V);
            if (vsnap === null) report(new CRDTError("malformed_state", "getStateSince() got a malformed version vector; sending full state."));
            const out = Object.create(null);
            const names = [...cols.keys()].sort();
            for (let i = 0; i < names.length; i++) {
                const col = cols.get(names[i]);
                out[names[i]] = (vsnap !== null && col._getStateSince) ? col._getStateSince(vsnap) : col._getState();
            }
            return { replicaId, clock: lamport, cols: out };
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
            // Cold path (between phases, never on a hot loop). Names SORTED and
            // `out` over Object.create(null) so two converged replicas produce a
            // byte-identical snapshot regardless of collection-creation order (the
            // per-collection snapshots already sort their own keys) and a
            // `__proto__` collection name round-trips as an OWN key (C-11 / C-12).
            const out = Object.create(null);
            const names = [...cols.keys()].sort();
            for (let i = 0; i < names.length; i++) out[names[i]] = cols.get(names[i]).snapshot();
            return out;
        },

        // Internal: route an error to the doc's onError hook. Used by transports
        // (connectBroadcastChannel) to fail closed on a crafted frame without
        // letting it throw out of the message handler.
        _report(e) { report(e); },

        dispose() {
            if (disposed) return;
            disposed = true;
            for (const [, col] of cols) col._dispose();
            cols.clear();
            vv.clear();
            opCbs.length = 0;
            opsCbs.length = 0;
            changeCbs.length = 0;
            history.undo.length = 0;
            history.redo.length = 0;
        },
    };
}

/* --- Optional transport: native BroadcastChannel (cross-tab) --------------- */

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
        // Fail closed: a crafted frame (bad op type, non-array ops, malformed
        // state) must not throw out of onmessage. The door already drops bad
        // fields via onError; this catch handles the residual envelope throws.
        try {
            if (m.t === "ops") {
                doc.applyOps(m.ops);
            } else if (m.t === "op") {            // accept legacy single-op frames too
                doc.applyOp(m.op);
            } else if (m.t === "req") {
                bc.postMessage({ t: "state", from: self, to: m.from, state: doc.getState() });
            } else if (m.t === "state" && (m.to === self || m.to == null)) {
                doc.mergeState(m.state);
            }
        } catch (e) {
            doc._report(e);
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
