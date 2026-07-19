import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

test("undo/redo: LWW-Map set over an existing value round-trips", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("k", "v0");
    m.set("k", "v1");
    assert.equal(m.get("k"), "v1");

    assert.equal(doc.undo(), true);
    assert.equal(m.get("k"), "v0", "undo restored the previous value");
    assert.equal(doc.redo(), true);
    assert.equal(m.get("k"), "v1", "redo re-applied the edit");
    doc.dispose();
});

test("undo/redo: setting a NEW key undoes to absent, redo re-adds", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("fresh", 7);
    assert.equal(m.has("fresh"), true);
    doc.undo();
    assert.equal(m.has("fresh"), false, "undo removed the newly-added key");
    doc.redo();
    assert.equal(m.get("fresh"), 7, "redo restored it");
    doc.dispose();
});

test("undo/redo: LWW-Map delete restores the value", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("k", "keep");
    m.delete("k");
    assert.equal(m.has("k"), false);
    doc.undo();
    assert.equal(m.get("k"), "keep", "undo restored the deleted value");
    doc.dispose();
});

test("undo/redo: OR-Set add then undo removes; redo re-adds", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const L = doc.array("L");
    L.push({ id: "x", v: 1 });
    assert.equal(L.hasId("x"), true);
    doc.undo();
    assert.equal(L.hasId("x"), false, "undo removed the added element");
    doc.redo();
    assert.equal(L.get("x").v, 1, "redo re-added it");
    doc.dispose();
});

test("undo/redo: OR-Set value update restores the previous value", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const L = doc.array("L");
    L.push({ id: "x", v: "old" });
    L.push({ id: "x", v: "new" });   // same id -> upd
    assert.equal(L.get("x").v, "new");
    doc.undo();
    assert.equal(L.get("x").v, "old", "undo restored the prior value under the stable id");
    doc.dispose();
});

test("undo/redo: OR-Set delete undoes by re-adding the value", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const L = doc.array("L");
    L.push({ id: "x", v: 42 });
    L.deleteById("x");
    assert.equal(L.hasId("x"), false);
    doc.undo();
    assert.equal(L.get("x").v, 42, "undo re-added the removed element");
    doc.redo();
    assert.equal(L.hasId("x"), false, "redo removed it again");
    doc.dispose();
});

test("undo/redo: counter inc/dec invert", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const c = doc.counter("c");
    c.inc(5);
    c.dec(2);
    assert.equal(c.peek(), 3);
    doc.undo();                       // undo the dec(2)
    assert.equal(c.peek(), 5);
    doc.undo();                       // undo the inc(5)
    assert.equal(c.peek(), 0);
    doc.redo();
    assert.equal(c.peek(), 5);
    doc.dispose();
});

test("undo/redo: a fresh edit invalidates the redo stack", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("k", 1);
    m.set("k", 2);
    doc.undo();                       // back to 1; redo now available
    assert.equal(doc.canRedo(), true);
    m.set("k", 9);                    // a new edit
    assert.equal(doc.canRedo(), false, "new edit cleared redo");
    assert.equal(doc.redo(), false);
    doc.dispose();
});

test("undo: multi-step LIFO across mixed collections", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m"); const c = doc.counter("c"); const L = doc.array("L");
    m.set("a", 1);
    c.inc(3);
    L.push({ id: "z", v: "hi" });
    // undo in reverse order
    doc.undo(); assert.equal(L.hasId("z"), false);
    doc.undo(); assert.equal(c.peek(), 0);
    doc.undo(); assert.equal(m.has("a"), false);
    assert.equal(doc.canUndo(), false);
    doc.dispose();
});

test("undo: bounded ring drops the oldest inverse (undoDepth)", () => {
    const doc = createCRDTDoc({ replicaId: "A", undoDepth: 3 });
    const m = doc.map("m");
    for (let i = 0; i < 6; i++) m.set("k", i);   // final value 5
    // Only the last 3 inverses are retained.
    let n = 0;
    while (doc.undo()) n++;
    assert.equal(n, 3, "ring retained exactly undoDepth inverses");
    assert.equal(m.get("k"), 2, "undid 5->4->3->2 (older history dropped)");
    doc.dispose();
});

test("undo: undoDepth 0 disables history entirely", () => {
    const doc = createCRDTDoc({ replicaId: "A", undoDepth: 0 });
    doc.map("m").set("k", 1);
    assert.equal(doc.canUndo(), false);
    assert.equal(doc.undo(), false);
    doc.dispose();
});

test("undo: the inverse is a real op that converges on a peer", () => {
    // Undo is a local edit: it emits an op. A peer applying it must converge.
    const a = createCRDTDoc({ replicaId: "A" });
    const b = createCRDTDoc({ replicaId: "B" });
    a.on("op", (op) => b.applyOp(op));

    a.map("m").set("k", "v1");
    a.map("m").set("k", "v2");
    assert.equal(b.map("m").get("k"), "v2");

    a.undo();
    assert.equal(a.map("m").get("k"), "v1");
    assert.equal(b.map("m").get("k"), "v1", "peer converged on the undo op");
    a.dispose(); b.dispose();
});

test("clearHistory wipes both stacks", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    doc.map("m").set("k", 1);
    doc.map("m").set("k", 2);
    doc.undo();
    assert.ok(doc.canUndo() || doc.canRedo());
    doc.clearHistory();
    assert.equal(doc.canUndo(), false);
    assert.equal(doc.canRedo(), false);
    doc.dispose();
});
