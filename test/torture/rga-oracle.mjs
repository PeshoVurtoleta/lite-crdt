/**
 * test/torture/rga-oracle.mjs -- an INDEPENDENT reference RGA sequence.
 *
 * The load-bearing oracle for ASSERTION 1 (T5). It shares NOTHING with CRDT.js's
 * implementation: no doubly-linked chain, no two-level id index, no pending
 * buffer, no scratch op, no incremental apply. It accumulates the raw op set and
 * RE-DERIVES the whole sequence FROM SCRATCH on every read (three commutative
 * passes over the accumulated ops, then a causal-tree preorder), so a bug shared
 * with the implementation cannot hide -- the two arrive at the same render by
 * entirely different roads or the gate fails.
 *
 * The three RGA rules, restated here in isolation:
 *   1. Insert: an anchor id (l, r) integrates after its origin; concurrent
 *      same-origin siblings order by (lamport, replicaId) DESCENDING. The total
 *      order is the causal-tree preorder: visit each origin, then its children
 *      in descending (l, r), recursively.
 *   2. Delete: a monotone flag on the birth-identity element; the remover stamp
 *      (dl, dr) converges by the higher (l, r).
 *   3. Move: a LWW position register whose VALUE is a freshly minted anchor id.
 *      The winning move (highest (l, r) stamp) sets the element's display anchor;
 *      the anchor it mints is (l, r) itself.
 *
 * Order-independence is by construction: anchors form a set keyed by (l, r); the
 * move register is a per-element max; the delete flag is monotone. So applying
 * the same op twice, or in any order, yields the identical derived state -- which
 * is exactly the CRDT convergence property the oracle exists to witness.
 */

const HEADKEY = "\x00head";

function cmpOK(aL, aR, bL, bR) {
    if (aL !== bL) return aL < bL ? -1 : 1;
    if (aR !== bR) return aR < bR ? -1 : 1;
    return 0;
}
function tsWins(al, ar, bl, br) {
    if (al !== bl) return al > bl;
    if (ar !== br) return ar > br;
    return false;
}

export function createOracle() {
    // The accumulated op set, deduped by identity so re-delivery does not grow it.
    // lins/lmv identity is the anchor they mint (t + r#l); ldel identity is its own
    // stamp (a distinct delete of the same element still converges the remover).
    const seen = new Set();
    const lins = [];
    const ldel = [];
    const lmv = [];

    function apply(op) {
        const t = op.t;
        if (t === "lins") {
            const id = "i:" + op.r + "#" + op.l;
            if (seen.has(id)) return;
            seen.add(id);
            lins.push({ l: op.l, r: op.r, or: op.or, ol: op.ol, v: op.v });
        } else if (t === "lmv") {
            const id = "m:" + op.r + "#" + op.l;
            if (seen.has(id)) return;
            seen.add(id);
            lmv.push({ l: op.l, r: op.r, bl: op.bl, br: op.br, or: op.or, ol: op.ol });
        } else if (t === "ldel") {
            const id = "d:" + op.r + "#" + op.l + ":" + op.br + "#" + op.bl;
            if (seen.has(id)) return;
            seen.add(id);
            ldel.push({ l: op.l, r: op.r, bl: op.bl, br: op.br });
        }
    }

    // Re-derive the full state from the accumulated op set. Three commutative
    // passes, then the preorder walk.
    function compute() {
        const anchors = new Map();   // "r#l" -> { l, r, or, ol }
        const elems = new Map();     // "br#bl" -> element record

        // Pass A -- inserts: every birth anchor and its birth element.
        for (let i = 0; i < lins.length; i++) {
            const o = lins[i];
            const ak = o.r + "#" + o.l;
            if (!anchors.has(ak)) anchors.set(ak, { l: o.l, r: o.r, or: o.or, ol: o.ol });
            if (!elems.has(ak)) elems.set(ak, { bl: o.l, br: o.r, v: o.v, del: false, dl: 0, dr: "", ml: o.l, mr: o.r, aKey: ak });
        }
        // Pass B -- moves: mint the destination anchor unconditionally, then a
        // per-element LWW register write (max stamp wins). Order-independent.
        for (let i = 0; i < lmv.length; i++) {
            const o = lmv[i];
            const ak = o.r + "#" + o.l;
            if (!anchors.has(ak)) anchors.set(ak, { l: o.l, r: o.r, or: o.or, ol: o.ol });
            const e = elems.get(o.br + "#" + o.bl);
            if (e !== undefined && tsWins(o.l, o.r, e.ml, e.mr)) { e.aKey = ak; e.ml = o.l; e.mr = o.r; }
        }
        // Pass C -- deletes: monotone flag, remover stamp converges by higher (l, r).
        for (let i = 0; i < ldel.length; i++) {
            const o = ldel[i];
            const e = elems.get(o.br + "#" + o.bl);
            if (e === undefined) continue;   // born-dead whose birth was never delivered: invisible anyway
            if (!e.del) { e.del = true; e.dl = o.l; e.dr = o.r; }
            else if (tsWins(o.l, o.r, e.dl, e.dr)) { e.dl = o.l; e.dr = o.r; }
        }

        // Causal-tree preorder over the anchor set. Children of each origin sorted
        // DESCENDING by (l, r); an anchor whose origin is absent is never reached
        // (orphan drop, exactly like the implementation's mergeState).
        const children = new Map();
        for (const [ak, a] of anchors) {
            const ok = a.or === null || a.or === undefined ? HEADKEY : a.or + "#" + a.ol;
            let arr = children.get(ok);
            if (arr === undefined) { arr = []; children.set(ok, arr); }
            arr.push(ak);
        }
        for (const arr of children.values()) {
            arr.sort((x, y) => {
                const ax = anchors.get(x), ay = anchors.get(y);
                return -cmpOK(ax.l, ax.r, ay.l, ay.r);   // descending
            });
        }
        // Element displayed at each anchor (live only). 1:1 for a valid op set.
        const displayAt = new Map();
        for (const e of elems.values()) if (!e.del) displayAt.set(e.aKey, e);

        // Iterative preorder from HEAD.
        const order = [];
        const stack = [];
        const headKids = children.get(HEADKEY);
        if (headKids !== undefined) for (let i = headKids.length - 1; i >= 0; i--) stack.push(headKids[i]);
        while (stack.length > 0) {
            const ak = stack.pop();
            order.push(ak);
            const kids = children.get(ak);
            if (kids !== undefined) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        }

        const values = [];
        const ids = [];
        for (let i = 0; i < order.length; i++) {
            const e = displayAt.get(order[i]);
            if (e !== undefined) { values.push(e.v); ids.push(e.br + "#" + e.bl); }
        }
        return { values, ids };
    }

    return {
        apply,
        values() { return compute().values; },
        ids() { return compute().ids; },
        render() { const s = compute(); return JSON.stringify({ v: s.values, i: s.ids }); },
    };
}

/** Render a live doc list the same way the oracle does, for byte comparison. */
export function renderList(list) {
    return JSON.stringify({ v: list.values(), i: list.ids() });
}
