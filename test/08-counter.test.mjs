import { test } from "node:test";
import assert from "node:assert/strict";
import { effect, dispose } from "@zakkster/lite-signal";
import { createCRDTDoc } from "../CRDT.js";
import { rng, shuffle } from "./helpers.mjs";

test("counter: inc/dec produce the running value", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const c = doc.counter("votes");
    assert.equal(c.peek(), 0);
    c.inc();          // +1
    c.inc(4);         // +5
    c.dec(2);         // +3
    assert.equal(c.peek(), 3);
    assert.equal(c.value(), 3);
    doc.dispose();
});

test("counter: inc/dec default to 1 and ignore non-positive deltas", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const c = doc.counter("n");
    c.inc(); c.inc(0); c.inc(-3); c.dec();
    assert.equal(c.peek(), 0);   // +1 (0 and -3 ignored) then -1
    doc.dispose();
});

test("counter: value() is reactive; change fires", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const c = doc.counter("likes");
    let seen = -1, runs = 0;
    const stop = effect(() => { seen = c.value(); runs++; });
    assert.equal(seen, 0);
    let changes = 0;
    const off = doc.on("change", () => changes++);
    c.inc(10);
    assert.equal(seen, 10, "effect re-ran with new value");
    assert.ok(runs >= 2);
    assert.ok(changes >= 1, "change event fired");
    off(); stop(); doc.dispose();
});

test("counter: concurrent inc/dec across replicas converge (order-independent)", () => {
    // Two replicas edit the SAME counter concurrently without syncing; capture
    // ops, then replay them shuffled into fresh docs. PN-Counter merges by max
    // per replica, so every replay order lands on the same value.
    const log = [];
    const a = createCRDTDoc({ replicaId: "A" });
    const b = createCRDTDoc({ replicaId: "B" });
    a.on("op", (op) => log.push(op));
    b.on("op", (op) => log.push(op));

    a.counter("c").inc(3);
    b.counter("c").inc(5);
    a.counter("c").dec(1);
    b.counter("c").inc(2);
    a.counter("c").dec(4);
    // Expected converged value: A: +3 -1 -4 = -2 ; B: +5 +2 = +7 ; total = 5
    const expected = 5;
    a.dispose(); b.dispose();

    for (const seed of [1, 2, 3, 42, 777]) {
        const order = shuffle(log, rng(seed));
        const d = createCRDTDoc({ replicaId: "Z" });
        for (const op of order) d.applyOp(op);
        assert.equal(d.counter("c").peek(), expected, "converged for seed " + seed);
        d.dispose();
    }
});

test("counter: op replay is idempotent (duplicate delivery is a no-op)", () => {
    const log = [];
    const a = createCRDTDoc({ replicaId: "A" });
    a.on("op", (op) => log.push(op));
    const c = a.counter("c");
    c.inc(7); c.dec(2); c.inc(1);
    a.dispose();

    const d = createCRDTDoc({ replicaId: "Z" });
    for (const op of log) d.applyOp(op);
    const once = d.counter("c").peek();
    for (const op of log) d.applyOp(op);   // deliver everything a second time
    for (const op of log) d.applyOp(op);   // and a third
    assert.equal(d.counter("c").peek(), once, "redelivery did not double-count");
    assert.equal(once, 6);
    d.dispose();
});

test("counter: getState / mergeState converge two docs", () => {
    const a = createCRDTDoc({ replicaId: "A" });
    const b = createCRDTDoc({ replicaId: "B" });
    a.counter("c").inc(10);
    a.counter("c").dec(3);
    b.counter("c").inc(4);

    a.mergeState(b.getState());
    b.mergeState(a.getState());
    assert.equal(a.counter("c").peek(), 11);
    assert.equal(b.counter("c").peek(), 11);
    a.dispose(); b.dispose();
});

test("counter: snapshot reflects the numeric value; kind mismatch throws", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    doc.counter("c").inc(2);
    assert.equal(doc.snapshot().c, 2);
    doc.map("m").set("x", 1);
    assert.throws(() => doc.counter("m"), /kind_mismatch|not a counter|already exists/);
    doc.dispose();
});
