import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc, CRDTError } from "../CRDT.js";

test("set then get returns the value", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("s");
    m.set("theme", "dark");
    assert.equal(m.get("theme"), "dark");
    assert.equal(m.has("theme"), true);
    doc.dispose();
});

test("delete removes a key and clears presence", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("s");
    m.set("theme", "dark");
    m.delete("theme");
    assert.equal(m.get("theme"), undefined);
    assert.equal(m.has("theme"), false);
    assert.equal(m.size, 0);
    doc.dispose();
});

test("keys / values / entries / size reflect present keys", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("s");
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.delete("b");
    assert.deepEqual(m.keys().sort(), ["a", "c"]);
    assert.deepEqual(m.values().sort(), [1, 3]);
    assert.equal(m.size, 2);
    assert.deepEqual(m.entries().sort(), [["a", 1], ["c", 3]]);
    doc.dispose();
});

test("last write wins by higher lamport", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [], opsB = [];
    A.on("op", (o) => opsA.push(o));
    B.on("op", (o) => opsB.push(o));
    A.map("s").set("k", "first");      // lamport 1 @ A
    B.applyOp(opsA[0]);                 // B observes lamport 1
    B.map("s").set("k", "second");     // lamport 2 @ B  (later)
    A.applyOp(opsB[0]);
    assert.equal(A.map("s").get("k"), "second");
    assert.equal(B.map("s").get("k"), "second");
    A.dispose(); B.dispose();
});

test("concurrent writes at equal lamport resolve by replicaId", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [], opsB = [];
    A.on("op", (o) => opsA.push(o));
    B.on("op", (o) => opsB.push(o));
    A.map("s").set("k", "from-A");     // lamport 1 @ A   (concurrent)
    B.map("s").set("k", "from-B");     // lamport 1 @ B   (concurrent)
    A.applyOp(opsB[0]);
    B.applyOp(opsA[0]);
    // tie on lamport 1 -> higher replicaId string ("B" > "A") wins on both
    assert.equal(A.map("s").get("k"), "from-B");
    assert.equal(B.map("s").get("k"), "from-B");
    A.dispose(); B.dispose();
});

test("delete vs concurrent set resolves by timestamp (delete newer wins)", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [], opsB = [];
    A.on("op", (o) => opsA.push(o));
    B.on("op", (o) => opsB.push(o));
    A.map("s").set("k", "v");          // lamport 1 @ A
    B.applyOp(opsA[0]);
    B.map("s").delete("k");            // lamport 2 @ B (newer than the set)
    A.applyOp(opsB[0]);
    assert.equal(A.map("s").has("k"), false);
    assert.equal(B.map("s").has("k"), false);
    A.dispose(); B.dispose();
});

test("set newer than a delete resurrects the key", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [], opsB = [];
    A.on("op", (o) => opsA.push(o));
    B.on("op", (o) => opsB.push(o));
    A.map("s").set("k", "v1");         // l1 @ A
    B.applyOp(opsA[0]);
    A.map("s").delete("k");            // l2 @ A
    B.applyOp(opsA[1]);
    B.map("s").set("k", "v2");         // l3 @ B (newer than the delete)
    A.applyOp(opsB[0]);
    assert.equal(A.map("s").get("k"), "v2");
    assert.equal(B.map("s").get("k"), "v2");
    A.dispose(); B.dispose();
});

test("re-applying the same op is a no-op (idempotent)", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [];
    A.on("op", (o) => opsA.push(o));
    A.map("s").set("k", "v");
    B.applyOp(opsA[0]);
    B.applyOp(opsA[0]);
    B.applyOp(opsA[0]);
    assert.equal(B.map("s").get("k"), "v");
    assert.equal(B.map("s").size, 1);
    A.dispose(); B.dispose();
});

test("an older write losing to a newer one does not overwrite", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [], opsB = [];
    A.on("op", (o) => opsA.push(o));
    B.on("op", (o) => opsB.push(o));
    A.map("s").set("k", "v1");         // l1
    B.applyOp(opsA[0]);
    B.map("s").set("k", "v2");         // l2 wins
    // now A applies B's l2, then re-sends its stale l1 to B
    A.applyOp(opsB[0]);
    B.applyOp(opsA[0]);                 // stale, should not win
    assert.equal(B.map("s").get("k"), "v2");
    A.dispose(); B.dispose();
});

test("numeric keys are coerced to strings", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("s");
    m.set(42, "answer");
    assert.equal(m.get("42"), "answer");
    assert.equal(m.get(42), "answer");
    doc.dispose();
});

test("snapshot returns plain present data", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("s");
    m.set("a", 1);
    m.set("b", 2);
    m.delete("a");
    assert.deepEqual(m.snapshot(), { b: 2 });
    doc.dispose();
});
