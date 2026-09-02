// C5.1 -- RGA list: identity + insert + order.
// Covers concurrent same-origin tie ordering, all-permutation 3-replica
// convergence (including out-of-order origin delivery and duplicate delivery),
// and the read-only projection guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

/** Capture every op a doc emits into `sink`. */
function capture(doc, sink) {
    doc.on("op", (op) => sink.push(op));
}

/** All permutations of an array (n! -- keep n small). */
function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        for (const p of permutations(rest)) out.push([arr[i]].concat(p));
    }
    return out;
}

test("single-replica insert builds the expected visible order", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    l.insert(0, "x");
    l.insert(1, "y");
    l.insert(1, "z"); // between x and y
    assert.deepEqual(l.values(), ["x", "z", "y"]);
    assert.equal(l.size, 3);
    assert.equal(l.ids().length, 3);
    doc.dispose();
});

test("insert index out of range fails closed (misconfigured)", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    l.insert(0, "x");
    const isMis = (e) => e && e.code === "misconfigured";
    assert.throws(() => l.insert(2, "y"), isMis);
    assert.throws(() => l.insert(-1, "y"), isMis);
    assert.throws(() => l.insert(1.5, "y"), isMis);
    doc.dispose();
});

test("concurrent same-origin inserts order by (lamport, replicaId) DESCENDING, identically on every replica", () => {
    // Two replicas each insert at index 0 of an empty list (origin === HEAD),
    // both at lamport 1. Order key (1,"B") > (1,"A"), so B precedes A everywhere.
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [], opsB = [];
    capture(A, opsA); capture(B, opsB);

    A.list("seq").insert(0, "va");
    B.list("seq").insert(0, "vb");

    // Cross-deliver.
    B.applyOps(opsA);
    A.applyOps(opsB);

    assert.deepEqual(A.list("seq").values(), ["vb", "va"]);
    assert.deepEqual(B.list("seq").values(), ["vb", "va"]);
    assert.deepEqual(A.list("seq").ids(), B.list("seq").ids());
    A.dispose(); B.dispose();
});

test("3-replica all-permutation delivery converges on values() and ids()", () => {
    // Concurrent authoring: three independent docs; A also chains a second insert
    // (origin = A's first node) so some permutations deliver it BEFORE its origin.
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const C = createCRDTDoc({ replicaId: "C" });
    const log = [];
    capture(A, log); capture(B, log); capture(C, log);

    A.list("seq").insert(0, "a0");
    A.list("seq").insert(1, "a1"); // origin = a0
    B.list("seq").insert(0, "b0");
    C.list("seq").insert(0, "c0");
    A.dispose(); B.dispose(); C.dispose();

    assert.equal(log.length, 4);

    let refValues = null, refIds = null;
    for (const perm of permutations(log)) {
        const d = createCRDTDoc({ replicaId: "Z" });
        d.applyOps(perm);
        const l = d.list("seq");
        assert.equal(l.size, 4, "every permutation integrates all 4 elements");
        const v = l.values(), ids = l.ids();
        if (refValues === null) { refValues = v; refIds = ids; }
        else {
            assert.deepEqual(v, refValues, "values diverged for a delivery permutation");
            assert.deepEqual(ids, refIds, "ids diverged for a delivery permutation");
        }
        d.dispose();
    }
    // a1 must sit immediately after a0 in the converged order.
    assert.ok(refValues.indexOf("a1") === refValues.indexOf("a0") + 1, "a1 follows its origin a0");
});

test("an insert delivered BEFORE its origin still converges once the origin arrives", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "a0");
    A.list("seq").insert(1, "a1");
    A.dispose();
    const [a0, a1] = log;

    const d = createCRDTDoc({ replicaId: "Z" });
    const l = d.list("seq");
    d.applyOp(a1);                       // origin (a0) unseen -> held in pending
    assert.equal(l.size, 0, "orphan insert is pended, not applied");
    assert.equal(l._retention().pending, 1);
    d.applyOp(a0);                       // origin arrives -> drains a1
    assert.equal(l.size, 2);
    assert.equal(l._retention().pending, 0);
    assert.deepEqual(l.values(), ["a0", "a1"]);
    d.dispose();
});

test("duplicate delivery is an idempotent no-op", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "a0");
    A.list("seq").insert(1, "a1");
    A.list("seq").insert(0, "a-1");
    A.dispose();

    const d = createCRDTDoc({ replicaId: "Z" });
    d.applyOps(log);
    const before = d.list("seq").values();
    d.applyOps(log);            // redeliver the whole log
    d.applyOps(log);            // and again
    assert.deepEqual(d.list("seq").values(), before);
    assert.equal(d.list("seq").size, 3);
    assert.equal(d.list("seq")._retention().anchors, 3, "no duplicate anchors from redelivery");
    d.dispose();
});

test("reentrant applyOp from a 'change' listener does not strand a pended orphan's drain", () => {
    // The scratchOp-reentrancy blocker: applyOp integrates the awaited origin and
    // fires ctx.changed(); a 'change' listener reentrantly applies an UNRELATED op,
    // clobbering the doc's reused scratchOp. drainPending must use the anchor
    // captured BEFORE ctx.changed(), not a re-read of the (now clobbered) scratch --
    // otherwise the orphan waiting on that anchor never drains and this replica
    // silently diverges. Pre-fix this test fails (size 1, orphan stranded).
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "a0");
    A.list("seq").insert(1, "a1"); // origin = a0
    A.dispose();
    const [a0, a1] = log;

    // The unrelated op the reentrant listener will apply -- a map set, which
    // overwrites scratchOp.r / scratchOp.l with foreign values.
    const foreign = { t: "set", c: "M", k: "x", v: 1, l: 7, r: "Q" };

    const d = createCRDTDoc({ replicaId: "Z" });
    const l = d.list("seq");
    d.applyOp(a1);                         // origin (a0) unseen -> pended
    assert.equal(l.size, 0);
    assert.equal(l._retention().pending, 1);

    // Reentrantly apply the foreign op exactly once, from inside the change fired
    // while a0 integrates (i.e. before drainPending(a0) runs).
    let fired = false;
    const off = d.on("change", () => {
        if (fired) return;
        fired = true;
        d.applyOp(foreign);                // clobbers scratchOp mid-applyLins(a0)
    });

    d.applyOp(a0);                         // integrate a0, fire change, THEN drain a1
    off();

    assert.equal(l._retention().pending, 0, "orphan a1 must have drained despite scratch clobber");
    assert.equal(l.size, 2);
    assert.deepEqual(l.values(), ["a0", "a1"]);

    // Control: a replica that received the ops in causal order, no reentrancy.
    const ctrl = createCRDTDoc({ replicaId: "C" });
    ctrl.applyOp(a0); ctrl.applyOp(a1); ctrl.applyOp(foreign);
    assert.deepEqual(l.values(), ctrl.list("seq").values());
    assert.deepEqual(l.ids(), ctrl.list("seq").ids());

    d.dispose(); ctrl.dispose();
});

test(".store is read-only: index write, push and splice all throw readonly", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    l.insert(0, "x");
    const isRO = (e) => e && e.code === "readonly";
    assert.throws(() => { l.store[0] = "nope"; }, isRO);
    assert.throws(() => l.store.push("nope"), isRO);
    assert.throws(() => l.store.splice(0, 0, "nope"), isRO);
    // state is unchanged after the rejected mutations
    assert.deepEqual(l.values(), ["x"]);
    doc.dispose();
});
