/**
 * Regression tests, one per finding, named by id (see ROADMAP.md sec. 3).
 *
 * The remote-boundary findings C-01..C-07 are registered { todo: true }: each
 * asserts the DESIRED (post-door) behaviour, so it fails today (reported as a
 * todo, not a suite failure) and turns green in v1.1.2 when the door lands and
 * the `todo` flag is removed. Every assertion body is a runnable reproduction.
 *
 * Door policy: reject-and-continue (decisions/0001-remote-op-door.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

test("C-01: a remote op with l=Infinity must not poison the Lamport clock", { todo: true }, () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    d.map("m").set("a", 1);
    d.applyOp({ t: "set", c: "m", k: "b", l: Infinity, r: "peer", v: 2 }); // must be rejected
    assert.ok(Number.isFinite(d.clock()), "clock went non-finite");
    d.map("m").set("c", 3);
    d.map("m").set("c", 4);
    assert.equal(d.map("m").get("c"), 4, "later local write lost -- clock is saturated");
    d.dispose();
});

test("C-02: a register written with l=NaN must not become permanently unwritable", { todo: true }, () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    d.applyOp({ t: "set", c: "m", k: "k", l: NaN, r: "peer", v: "stuck" }); // must be rejected
    d.map("m").set("k", "fresh");
    assert.equal(d.map("m").get("k"), "fresh", "NaN-stamped register froze the key");
    d.dispose();
});

test("C-03: a remote counter op with a non-number cumulative must not poison the value", { todo: true }, () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    const c = d.counter("c");
    c.inc(5);
    d.applyOp({ t: "cinc", c: "c", r: "peer", p: "999" });   // must be rejected
    d.applyOp({ t: "cinc", c: "c", r: "peer2", p: Infinity }); // must be rejected
    d.applyOp({ t: "cinc", c: "c", r: "peer3", p: NaN });      // must be rejected
    assert.equal(typeof c.peek(), "number");
    assert.ok(Number.isFinite(c.peek()), "counter value became non-finite: " + c.peek());
    assert.equal(c.peek(), 5, "poison ops changed the value");
    d.dispose();
});

test("C-04: applyOp must reject a set op with a missing or non-number l", { todo: true }, () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    d.map("m").set("seed", 0);
    const before = JSON.stringify(d.map("m").snapshot());
    d.applyOp({ t: "set", c: "m", k: "b", r: "peer", v: 1 });          // no l -> reject
    d.applyOp({ t: "set", c: "m", k: "b", l: "5", r: "peer", v: 1 });  // string l -> reject
    assert.equal(JSON.stringify(d.map("m").snapshot()), before, "a malformed op mutated state");
    d.dispose();
});

test("C-05: a kind-mismatched remote op must not throw out of applyOps", { todo: true }, () => {
    const errors = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errors.push(e) });
    d.map("x").set("a", 1); // 'x' is a map locally
    assert.doesNotThrow(() => d.applyOps([
        { t: "add", c: "x", id: "1", n: 0, v: {}, l: 5, r: "peer" }, // set op on a map name
        { t: "set", c: "x", k: "b", l: 6, r: "peer", v: 2 },          // valid, must still apply
    ]));
    assert.equal(d.map("x").get("b"), 2, "the valid op after the bad one was dropped");
    assert.ok(errors.length >= 1, "the kind-mismatch was not reported to onError");
    d.dispose();
});

test("C-06: mergeState must not crash on a malformed payload", { todo: true }, () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    assert.doesNotThrow(() => d.mergeState({ cols: { A: { kind: "set", adds: {}, values: {} } } })); // no `removed`
    d.dispose();
});

test("C-07: the Lamport clock must not silently freeze at 2^53", { todo: true }, () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    d.applyOp({ t: "set", c: "m", k: "x", l: 2 ** 53, r: "peer", v: "remote" }); // must be rejected/bounded
    const c1 = d.clock();
    d.map("m").set("y", "a");
    assert.notEqual(d.clock(), c1, "clock did not advance after a local write");
    d.dispose();
});
