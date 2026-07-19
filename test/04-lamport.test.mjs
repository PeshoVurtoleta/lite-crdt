import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

test("clock starts at 0 (or configured value) and is monotonic on local ops", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    assert.equal(doc.clock(), 0);
    const m = doc.map("m");
    m.set("a", 1);
    assert.equal(doc.clock(), 1);
    m.set("b", 2);
    assert.equal(doc.clock(), 2);
    m.delete("a");
    assert.equal(doc.clock(), 3);
    doc.dispose();
});

test("clock can be seeded via options", () => {
    const doc = createCRDTDoc({ replicaId: "A", clock: 41 });
    doc.map("m").set("x", 1);
    assert.equal(doc.clock(), 42);
    doc.dispose();
});

test("applyOp advances the clock past an observed remote op", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    assert.equal(doc.clock(), 0);
    doc.applyOp({ t: "set", c: "m", k: "x", v: 1, l: 50, r: "Z" });
    assert.equal(doc.clock(), 50, "clock jumps to observed lamport");
    // a subsequent local op must exceed the observed value
    doc.map("m").set("y", 2);
    assert.equal(doc.clock(), 51);
    doc.dispose();
});

test("a lower-lamport remote op does not move the clock backward", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    doc.map("m").set("x", 1); // clock 1
    doc.map("m").set("y", 1); // clock 2
    doc.applyOp({ t: "set", c: "m", k: "z", v: 9, l: 1, r: "Z" }); // older
    assert.equal(doc.clock(), 2, "clock unchanged by an older op");
    doc.dispose();
});

test("the OR-Set tag counter is independent of the lamport clock", () => {
    // Two adds produce distinct tags even though both advance lamport; the tag
    // counter increments per add, the lamport per op.
    const A = createCRDTDoc({ replicaId: "A" });
    const ops = [];
    A.on("op", (o) => ops.push(o));
    A.array("L").push({ id: "1" });
    A.array("L").push({ id: "2" });
    const addOps = ops.filter((o) => o.t === "add");
    assert.equal(addOps.length, 2);
    assert.notEqual(addOps[0].n, addOps[1].n, "tag counters differ");
    assert.equal(addOps[0].r, "A");
    A.dispose();
});

test("lamport stays consistent through a round trip of ops", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [], opsB = [];
    A.on("op", (o) => opsA.push(o));
    B.on("op", (o) => opsB.push(o));
    A.map("m").set("k", 1);     // A: l1
    B.applyOp(opsA[0]);          // B observes l1 -> B.clock 1
    B.map("m").set("k", 2);     // B: l2
    assert.equal(B.clock(), 2);
    A.applyOp(opsB[0]);          // A observes l2 -> A.clock 2
    assert.equal(A.clock(), 2);
    A.map("m").set("k", 3);     // A: l3 (exceeds everything seen)
    assert.equal(A.clock(), 3);
    A.dispose(); B.dispose();
});
