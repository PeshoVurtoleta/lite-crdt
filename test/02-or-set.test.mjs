import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

const ids = (set) => set.values().map((v) => v.id);

test("push adds elements and get/has reflect them", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const t = doc.array("todos");
    t.push({ id: "1", text: "milk" });
    t.push({ id: "2", text: "eggs" });
    assert.equal(t.size, 2);
    assert.equal(t.hasId("1"), true);
    assert.equal(t.has({ id: "2" }), true);
    assert.equal(t.get("1").text, "milk");
    assert.deepEqual(ids(t), ["1", "2"]);
    doc.dispose();
});

test("delete by value and deleteById remove elements", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const t = doc.array("todos");
    t.push({ id: "1", text: "a" });
    t.push({ id: "2", text: "b" });
    assert.equal(t.delete({ id: "1" }), true);
    assert.equal(t.hasId("1"), false);
    assert.equal(t.deleteById("2"), true);
    assert.equal(t.size, 0);
    // deleting an absent id is a no-op
    assert.equal(t.deleteById("nope"), false);
    doc.dispose();
});

test("re-adding a present id edits its value without reordering (LWW value)", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const t = doc.array("todos");
    t.push({ id: "1", text: "milk", done: false });
    t.push({ id: "2", text: "eggs", done: false });
    t.push({ id: "3", text: "bread", done: false });
    t.push({ id: "1", text: "milk", done: true }); // edit element 1
    assert.deepEqual(ids(t), ["1", "2", "3"], "order unchanged after edit");
    assert.equal(t.get("1").done, true, "value updated in place");
    doc.dispose();
});

test("deterministic ordering across replicas by first-add timestamp", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [], opsB = [];
    A.on("op", (o) => opsA.push(o));
    B.on("op", (o) => opsB.push(o));
    A.array("L").push({ id: "x" });  // l1 @ A
    B.array("L").push({ id: "y" });  // l1 @ B  (concurrent, same lamport)
    // cross-deliver
    opsB.forEach((o) => A.applyOp(o));
    opsA.forEach((o) => B.applyOp(o));
    // tie on lamport 1 -> ordered by replicaId ("A" before "B")
    assert.deepEqual(ids(A.array("L")), ["x", "y"]);
    assert.deepEqual(ids(B.array("L")), ["x", "y"]);
    A.dispose(); B.dispose();
});

test("LWW value resolution across concurrent edits", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [], opsB = [];
    A.on("op", (o) => opsA.push(o));
    B.on("op", (o) => opsB.push(o));
    A.array("L").push({ id: "1", v: "base" });   // l1 @ A (add)
    B.applyOp(opsA[0]);
    A.array("L").push({ id: "1", v: "from-A" });  // l2 @ A (upd)
    B.array("L").push({ id: "1", v: "from-B" });  // l2 @ B (upd, concurrent)
    A.applyOp(opsB[0]);
    B.applyOp(opsA[1]);
    // tie on lamport 2 -> replicaId "B" wins
    assert.equal(A.array("L").get("1").v, "from-B");
    assert.equal(B.array("L").get("1").v, "from-B");
    A.dispose(); B.dispose();
});

test("observed-remove: a concurrent fresh add wins over a remove (add-wins)", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [], opsB = [];
    A.on("op", (o) => opsA.push(o));
    B.on("op", (o) => opsB.push(o));
    A.array("L").push({ id: "k", v: 1 });   // A: add tag A#0
    A.array("L").deleteById("k");           // A: removes observed {A#0}
    B.array("L").push({ id: "k", v: 2 });   // B: concurrent fresh add tag B#0 (never saw A#0)
    opsA.forEach((o) => B.applyOp(o));
    opsB.forEach((o) => A.applyOp(o));
    assert.equal(A.array("L").hasId("k"), true, "element survives because B's tag was never observed-removed");
    assert.equal(B.array("L").hasId("k"), true);
    assert.deepEqual(A.array("L").snapshot(), B.array("L").snapshot());
    A.dispose(); B.dispose();
});

test("remove then later re-add restores membership with a new tag", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const t = doc.array("L");
    t.push({ id: "1", v: "a" });
    t.deleteById("1");
    assert.equal(t.hasId("1"), false);
    t.push({ id: "1", v: "b" });            // genuine re-add (not a member -> add op)
    assert.equal(t.hasId("1"), true);
    assert.equal(t.get("1").v, "b");
    doc.dispose();
});

test("duplicate op delivery is idempotent", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [];
    A.on("op", (o) => opsA.push(o));
    A.array("L").push({ id: "1", v: 1 });
    A.array("L").push({ id: "2", v: 2 });
    A.array("L").deleteById("1");
    // deliver everything to B twice, in order
    [...opsA, ...opsA].forEach((o) => B.applyOp(o));
    assert.deepEqual(B.array("L").snapshot(), A.array("L").snapshot());
    assert.deepEqual(ids(B.array("L")), ["2"]);
    A.dispose(); B.dispose();
});

test("custom identify function keys elements", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const t = doc.array("L", { identify: (v) => v.sku });
    t.push({ sku: "AAA", qty: 1 });
    t.push({ sku: "BBB", qty: 2 });
    t.push({ sku: "AAA", qty: 5 });   // edit by sku
    assert.equal(t.size, 2);
    assert.equal(t.get("AAA").qty, 5);
    doc.dispose();
});

test("missing id throws a misconfigured error", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const t = doc.array("L");
    assert.throws(() => t.push({ text: "no id here" }), (e) => e.code === "misconfigured");
    doc.dispose();
});

test("numeric ids are coerced consistently", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const t = doc.array("L");
    t.push({ id: 7, v: "seven" });
    assert.equal(t.hasId(7), true);
    assert.equal(t.hasId("7"), true);
    assert.equal(t.get(7).v, "seven");
    doc.dispose();
});

test("snapshot returns plain ordered values", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const t = doc.array("L");
    t.push({ id: "1", v: "a" });
    t.push({ id: "2", v: "b" });
    const snap = t.snapshot();
    assert.ok(Array.isArray(snap));
    assert.deepEqual(snap.map((x) => x.id), ["1", "2"]);
    doc.dispose();
});
