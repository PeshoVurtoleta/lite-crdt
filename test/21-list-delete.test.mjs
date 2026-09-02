// C5.2 -- RGA list: delete + tombstones (ldel).
// Covers local delete(index)/deleteById(bl, br), monotone-del convergence under
// reorder + duplication, concurrent delete of one element (idempotent, del
// monotone), the delete-before-insert placeholder path (born-dead on every
// replica), the anchor-survives invariant (a deleted anchor still orders a
// concurrent insert that named it as origin), the documented no-op for
// delete-of-missing, and the proj.length === size invariant across deletes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

function capture(doc, sink) { doc.on("op", (op) => sink.push(op)); }

function makePrng(seed) {
    let x = seed >>> 0 || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}
function shuffle(arr, rng) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = rng() % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        for (const p of permutations(rest)) out.push([arr[i]].concat(p));
    }
    return out;
}

test("local delete(index) removes the visible element and keeps proj.length === size", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    l.insert(0, "x"); l.insert(1, "y"); l.insert(2, "z");
    assert.equal(l.delete(1), true);
    assert.deepEqual(l.values(), ["x", "z"]);
    assert.equal(l.size, 2);
    assert.equal(l.store.length, l.size, "proj.length === size after a delete");
    // the birth anchor of "y" survives as a tombstone (still linked)
    assert.equal(l._retention().anchors, 3, "the deleted anchor is retained, not unlinked");
    assert.equal(l._retention().elems, 2, "count tracks LIVE elements only");
    l.delete(0);
    l.delete(0);
    assert.deepEqual(l.values(), []);
    assert.equal(l.size, 0);
    assert.equal(l.store.length, 0);
    doc.dispose();
});

test("delete(index) out of range / non-integer fails closed (misconfigured)", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    l.insert(0, "x");
    const isMis = (e) => e && e.code === "misconfigured";
    assert.throws(() => l.delete(1), isMis, "index === size must throw (no live element there)");
    assert.throws(() => l.delete(-1), isMis);
    assert.throws(() => l.delete(1.5), isMis);
    assert.throws(() => l.delete(NaN), isMis);
    assert.throws(() => l.delete(Infinity), isMis);
    assert.throws(() => l.delete(null), isMis);
    assert.throws(() => l.delete(undefined), isMis);
    // empty list: any delete throws
    l.delete(0);
    assert.throws(() => l.delete(0), isMis, "delete on an empty list throws");
    doc.dispose();
});

test("deleteById(bl, br) deletes a live element and is a no-op (false) on a missing / already-deleted one", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    const id = l.insert(0, "x"); // "A#1"
    assert.equal(id, "A#1");
    // nonexistent birth -> false, emits nothing
    const emitted = [];
    capture(doc, emitted);
    assert.equal(l.deleteById(999, "nobody"), false, "deleteById on a nonexistent id returns false");
    assert.equal(emitted.length, 0, "a no-op deleteById emits no op");
    // real birth -> true
    assert.equal(l.deleteById(1, "A"), true);
    assert.deepEqual(l.values(), []);
    assert.equal(emitted.length, 1, "a real delete emits one ldel");
    assert.equal(emitted[0].t, "ldel");
    // already deleted -> false, no further op
    assert.equal(l.deleteById(1, "A"), false, "deleteById on an already-deleted id returns false");
    assert.equal(emitted.length, 1, "an already-deleted deleteById emits nothing further");
    doc.dispose();
});

test("delete converges under reorder + duplication (monotone del)", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "a"); // A#1
    A.list("seq").insert(1, "b"); // A#2
    A.list("seq").insert(2, "c"); // A#3
    A.list("seq").deleteById(2, "A"); // delete "b"
    A.dispose();
    assert.equal(log.length, 4);

    // Reference single-delivery outcome.
    const ref = createCRDTDoc({ replicaId: "Z" });
    ref.applyOps(log);
    assert.deepEqual(ref.list("seq").values(), ["a", "c"]);
    ref.dispose();

    // Every permutation, each op delivered 1..3 times, converges identically.
    const rng = makePrng(0xBEEF);
    for (const perm of permutations(log)) {
        const flooded = [];
        for (const op of perm) { const n = 1 + (rng() % 3); for (let i = 0; i < n; i++) flooded.push(op); }
        const d = createCRDTDoc({ replicaId: "P" });
        d.applyOps(shuffle(flooded, rng));
        assert.deepEqual(d.list("seq").values(), ["a", "c"], "delete diverged under a reorder+dup permutation");
        assert.equal(d.list("seq").store.length, d.list("seq").size);
        d.dispose();
    }
});

test("concurrent delete of the SAME element is idempotent -- both replicas agree, del monotone", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "x"); // A#1
    A.dispose();
    const insertOp = log[0];

    // Two replicas both delete the same element concurrently (different stamps).
    const R1 = createCRDTDoc({ replicaId: "R1" });
    const R2 = createCRDTDoc({ replicaId: "R2" });
    R1.applyOp(insertOp); R2.applyOp(insertOp);
    const del1 = { t: "ldel", c: "seq", l: 5, r: "R1", bl: 1, br: "A" };
    const del2 = { t: "ldel", c: "seq", l: 7, r: "R2", bl: 1, br: "A" };
    // R1 sees its own delete first, then R2's; R2 the opposite order.
    R1.applyOp(del1); R1.applyOp(del2);
    R2.applyOp(del2); R2.applyOp(del1);

    assert.deepEqual(R1.list("seq").values(), [], "R1: element deleted");
    assert.deepEqual(R2.list("seq").values(), [], "R2: element deleted");
    assert.equal(R1.list("seq").size, 0);
    assert.equal(R2.list("seq").size, 0);
    // Converged snapshots byte-identical regardless of delete-arrival order.
    assert.equal(JSON.stringify(R1.snapshot()), JSON.stringify(R2.snapshot()));
    // Re-delivering both deletes in any order is a pure no-op.
    R1.applyOp(del2); R1.applyOp(del1); R1.applyOp(del1);
    assert.deepEqual(R1.list("seq").values(), []);
    R1.dispose(); R2.dispose();
});

test("delete delivered BEFORE its birth insert converges to DELETED on every replica (placeholder)", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "x"); // A#1
    A.dispose();
    const insertOp = log[0];
    const delOp = { t: "ldel", c: "seq", l: 9, r: "peer", bl: 1, br: "A" };

    // ldel first, then lins: the element must be BORN-DEAD, never briefly visible.
    const d = createCRDTDoc({ replicaId: "Z" });
    const l = d.list("seq");
    d.applyOp(delOp);
    assert.equal(l.size, 0, "an ldel for an unseen birth applies to nothing yet");
    assert.equal(l._retention().pending, 1, "the ldel is held as a placeholder");
    assert.equal(l._retention().anchors, 0, "no anchor exists until the birth arrives");
    d.applyOp(insertOp);
    assert.equal(l.size, 0, "the element is born-dead (delete wins over the late insert)");
    assert.deepEqual(l.values(), []);
    assert.equal(l._retention().pending, 0, "the placeholder is reconciled, not stranded");
    assert.equal(l._retention().anchors, 1, "the anchor is created (and linked) even though born-dead");
    assert.equal(l.store.length, 0);

    // Every permutation, with duplication, converges to the same born-dead state.
    const rng = makePrng(0x1234);
    for (const perm of permutations([insertOp, delOp])) {
        const dd = createCRDTDoc({ replicaId: "P" });
        for (const op of perm) { dd.applyOp(op); dd.applyOp(op); } // each twice
        assert.deepEqual(dd.list("seq").values(), [], "born-dead diverged for a permutation");
        assert.equal(dd.list("seq").size, 0);
        assert.equal(dd.list("seq")._retention().pending, 0);
        dd.dispose();
    }
    d.dispose();
});

test("anchor-survives: a deleted anchor still orders a concurrent insert that named it as origin", () => {
    // A inserts "a0" (A#1); B concurrently inserts "b1" naming a0 as its origin.
    // A deletes a0. On every replica, b1 must land immediately after a0's (now
    // tombstoned) anchor -- the delete must NOT orphan the concurrent child.
    const A = createCRDTDoc({ replicaId: "A" });
    const logA = [];
    capture(A, logA);
    const id = A.list("seq").insert(0, "a0"); // A#1
    assert.equal(id, "A#1");
    A.dispose();
    const a0 = logA[0];

    // B's insert names a0 as origin (or="A", ol=1) at B's lamport.
    const b1 = { t: "lins", c: "seq", l: 2, r: "B", or: "A", ol: 1, v: "b1" };
    // A's delete of a0.
    const delA0 = { t: "ldel", c: "seq", l: 3, r: "A", bl: 1, br: "A" };

    let ref = null;
    for (const perm of permutations([a0, b1, delA0])) {
        const d = createCRDTDoc({ replicaId: "Z" });
        d.applyOps(perm);
        const vals = d.list("seq").values();
        // a0 is deleted; only b1 remains, but it was correctly positioned after a0.
        assert.deepEqual(vals, ["b1"], "the concurrent child of a deleted anchor was lost/misordered");
        assert.deepEqual(d.list("seq").ids(), ["B#2"]);
        if (ref === null) ref = JSON.stringify(d.snapshot());
        else assert.equal(JSON.stringify(d.snapshot()), ref, "anchor-survives ordering diverged across a permutation");
        d.dispose();
    }
});

test("delete then re-insert a fresh element keeps proj.length === size and does not resurrect the tombstone", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    l.insert(0, "x"); l.insert(1, "y");
    l.deleteById(1, "A"); // delete "x"
    assert.deepEqual(l.values(), ["y"]);
    l.insert(0, "z"); // fresh element at head
    assert.deepEqual(l.values(), ["z", "y"]);
    assert.equal(l.store.length, l.size);
    // Redeliver nothing new; snapshot is stable, anchors include the tombstone.
    assert.equal(l._retention().elems, 2);
    assert.equal(l._retention().anchors, 3, "tombstone anchor retained alongside two live anchors");
    doc.dispose();
});
