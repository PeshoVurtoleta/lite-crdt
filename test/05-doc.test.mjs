import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc, CRDTError } from "../CRDT.js";

test("named collections are cached (same instance per name)", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    assert.equal(doc.map("settings"), doc.map("settings"));
    assert.equal(doc.array("todos"), doc.array("todos"));
    doc.dispose();
});

test("requesting an existing name as the wrong kind throws kind_mismatch", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    doc.map("x");
    assert.throws(() => doc.array("x"), (e) => e instanceof CRDTError && e.code === "kind_mismatch");
    doc.array("y");
    assert.throws(() => doc.map("y"), (e) => e.code === "kind_mismatch");
    doc.dispose();
});

test("local mutations emit exactly one op each", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const ops = [];
    doc.on("op", (o) => ops.push(o));
    doc.map("m").set("a", 1);
    doc.map("m").delete("a");
    doc.array("L").push({ id: "1" });
    assert.equal(ops.length, 3);
    assert.deepEqual(ops.map((o) => o.t), ["set", "del", "add"]);
    doc.dispose();
});

test("applyOp does not echo onto the op stream", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [];
    A.on("op", (o) => opsA.push(o));
    let bEmitted = 0;
    B.on("op", () => bEmitted++);
    A.map("m").set("k", "v");
    B.applyOp(opsA[0]);
    assert.equal(bEmitted, 0, "applying a remote op must not emit an op");
    assert.equal(B.map("m").get("k"), "v");
    A.dispose(); B.dispose();
});

test("on() returns a working disposer", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const ops = [];
    const off = doc.on("op", (o) => ops.push(o));
    doc.map("m").set("a", 1);
    off();
    doc.map("m").set("b", 2);
    assert.equal(ops.length, 1, "no ops captured after disposer called");
    doc.dispose();
});

test("change fires on both local and remote mutations", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [];
    A.on("op", (o) => opsA.push(o));
    let changes = 0;
    B.on("change", () => changes++);
    B.map("m").set("local", 1);   // local change
    A.map("m").set("remote", 2);
    B.applyOp(opsA[0]);            // remote change
    assert.equal(changes, 2);
    A.dispose(); B.dispose();
});

test("a throwing listener is isolated and routed to onError", () => {
    const errors = [];
    const doc = createCRDTDoc({ replicaId: "A", onError: (e) => errors.push(e) });
    doc.on("op", () => { throw new Error("listener boom"); });
    let secondRan = false;
    doc.on("op", () => { secondRan = true; });
    doc.map("m").set("a", 1); // should not throw out of set()
    assert.equal(secondRan, true, "second listener still ran");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /boom/);
    doc.dispose();
});

test("on() rejects unknown event names and non-functions", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    assert.throws(() => doc.on("nope", () => {}), (e) => e.code === "misconfigured");
    assert.throws(() => doc.on("op", 123), (e) => e.code === "misconfigured");
    doc.dispose();
});

test("applyOp rejects malformed ops", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    assert.throws(() => doc.applyOp(null), (e) => e.code === "malformed_op");
    assert.throws(() => doc.applyOp({ t: "set" }), (e) => e.code === "malformed_op"); // no c
    assert.throws(() => doc.applyOp({ t: "bogus", c: "m" }), (e) => e.code === "malformed_op");
    doc.dispose();
});

test("applyOp auto-vivifies an unseen collection by op kind", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    doc.applyOp({ t: "set", c: "fresh-map", k: "x", v: 1, l: 5, r: "Z" });
    doc.applyOp({ t: "add", c: "fresh-set", id: "1", n: 0, v: 9, l: 6, r: "Z" });
    assert.equal(doc.map("fresh-map").get("x"), 1);
    assert.equal(doc.array("fresh-set").get("1"), 9);
    doc.dispose();
});

test("ops are JSON round-trippable (transport-safe)", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [];
    A.on("op", (o) => opsA.push(o));
    A.map("m").set("k", { nested: true });
    A.array("L").push({ id: "1", v: "x" });
    A.array("L").deleteById("1");
    for (const op of opsA) {
        const wire = JSON.parse(JSON.stringify(op));
        B.applyOp(wire);
    }
    assert.deepEqual(B.snapshot(), A.snapshot());
    A.dispose(); B.dispose();
});

test("getState / mergeState hydrates a fresh replica", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    A.map("settings").set("theme", "dark");
    A.map("settings").set("font", "mono");
    A.array("todos").push({ id: "1", text: "a" });
    A.array("todos").push({ id: "2", text: "b" });
    A.array("todos").deleteById("1");

    const C = createCRDTDoc({ replicaId: "C" });
    C.mergeState(A.getState());
    assert.deepEqual(C.snapshot(), A.snapshot());
    assert.ok(C.clock() >= A.clock(), "clock carried forward");
    A.dispose(); C.dispose();
});

test("mergeState is idempotent and commutative", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    A.map("m").set("a", 1);
    A.array("L").push({ id: "1", v: 1 });
    B.map("m").set("b", 2);
    B.array("L").push({ id: "2", v: 2 });

    const sA = A.getState();
    const sB = B.getState();

    // merge in one order
    const X = createCRDTDoc({ replicaId: "X" });
    X.mergeState(sA); X.mergeState(sB); X.mergeState(sA); // includes a duplicate
    // merge in the other order
    const Y = createCRDTDoc({ replicaId: "Y" });
    Y.mergeState(sB); Y.mergeState(sA);

    assert.deepEqual(X.snapshot(), Y.snapshot());
    A.dispose(); B.dispose(); X.dispose(); Y.dispose();
});

test("a mix of ops and a state merge converge to the same result", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const ops = [];
    A.on("op", (o) => ops.push(o));
    A.map("m").set("a", 1);
    A.array("L").push({ id: "1", v: 1 });
    A.array("L").push({ id: "1", v: 2 }); // edit
    const state = A.getState();

    // B gets the full state; then a late op also delivered via op stream
    const B = createCRDTDoc({ replicaId: "B" });
    B.mergeState(state);
    A.map("m").set("b", 3);
    B.applyOp(ops[ops.length - 1]);
    assert.deepEqual(B.snapshot(), A.snapshot());
    A.dispose(); B.dispose();
});

test("dispose makes further mutations and applyOp silent", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    let ops = 0;
    doc.on("op", () => ops++);
    const m = doc.map("m");
    m.set("a", 1);
    doc.dispose();
    // applyOp after dispose is a no-op and emits nothing
    doc.applyOp({ t: "set", c: "m", k: "b", v: 2, l: 99, r: "Z" });
    assert.equal(ops, 1);
});
