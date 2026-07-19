import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { createCRDTDoc } from "../CRDT.js";

test("transact: a burst of edits flushes as ONE ops payload", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const opsFrames = [];
    const singleOps = [];
    doc.on("ops", (ops) => opsFrames.push(ops));
    doc.on("op", (op) => singleOps.push(op));

    doc.transact(() => {
        doc.map("m").set("a", 1);
        doc.map("m").set("b", 2);
        doc.array("L").push({ id: "x", v: 9 });
    });

    assert.equal(opsFrames.length, 1, "exactly one 'ops' frame for the transaction");
    assert.equal(opsFrames[0].length, 3, "all three ops in the single frame");
    assert.equal(singleOps.length, 3, "'op' listeners still see each op individually");
    doc.dispose();
});

test("transact: applyOps on a peer reproduces the whole burst", () => {
    const a = createCRDTDoc({ replicaId: "A" });
    const b = createCRDTDoc({ replicaId: "B" });
    a.on("ops", (ops) => b.applyOps(ops));   // one frame across the "wire"

    a.transact(() => {
        a.map("m").set("title", "hello");
        a.counter("hits").inc(3);
        a.array("tags").push({ id: "t1", v: "red" });
    });

    assert.equal(b.map("m").get("title"), "hello");
    assert.equal(b.counter("hits").peek(), 3);
    assert.equal(b.array("tags").get("t1").v, "red");
    a.dispose(); b.dispose();
});

test("transact: change fires once and reactive readers update once", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    let changes = 0;
    doc.on("change", () => changes++);

    const m = doc.map("m");
    let runs = 0;
    const stop = effect(() => { m.get("a"); m.get("b"); m.get("c"); runs++; });
    const runsBefore = runs;

    doc.transact(() => { m.set("a", 1); m.set("b", 2); m.set("c", 3); });

    assert.equal(changes, 1, "one 'change' event for the whole transaction");
    assert.equal(runs - runsBefore, 1, "reactive reader re-ran exactly once (batched)");
    stop(); doc.dispose();
});

test("transact: nested transactions flush only at the outermost boundary", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const frames = [];
    doc.on("ops", (ops) => frames.push(ops.length));

    doc.transact(() => {
        doc.map("m").set("a", 1);
        doc.transact(() => {
            doc.map("m").set("b", 2);
            doc.map("m").set("c", 3);
        });
        doc.map("m").set("d", 4);
    });

    assert.deepEqual(frames, [4], "one frame of 4 ops, flushed at the outer close");
    doc.dispose();
});

test("transact: returns the function's return value", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const r = doc.transact(() => { doc.map("m").set("k", 1); return 99; });
    assert.equal(r, 99);
    doc.dispose();
});

test("transact: an empty transaction emits nothing", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    let opsFrames = 0, changes = 0;
    doc.on("ops", () => opsFrames++);
    doc.on("change", () => changes++);
    doc.transact(() => { /* no edits */ });
    assert.equal(opsFrames, 0);
    assert.equal(changes, 0);
    doc.dispose();
});

test("transact: a throw still flushes the ops emitted before it", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const frames = [];
    doc.on("ops", (ops) => frames.push(ops.length));
    assert.throws(() => {
        doc.transact(() => {
            doc.map("m").set("a", 1);
            doc.map("m").set("b", 2);
            throw new Error("boom");
        });
    }, /boom/);
    assert.deepEqual(frames, [2], "the two staged ops flushed despite the throw");
    assert.equal(doc.map("m").get("a"), 1);
    doc.dispose();
});
