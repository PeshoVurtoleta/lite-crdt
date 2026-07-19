// Extra coverage for @zakkster/lite-crdt: zero-GC steady state, fine-grained
// vs coarse reactivity, the read-only .store enforcement (which the README
// documents prominently), pool reclamation via stats(), the post-dispose
// collection-creation leak regression, and a heap-delta guard for the hot
// paths the README claims are "allocation-light".
//
// Pairs with 01-06. The single GC-required test (heap delta) skips silently
// when globalThis.gc is unavailable, so `npm test` is clean without
// --expose-gc; engage it with --expose-gc to run the heap-delta block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stats } from "@zakkster/lite-signal";
import { effect } from "@zakkster/lite-signal";
import { createCRDTDoc, CRDTError } from "../CRDT.js";

// ===========================================================================
// Read-only .store enforcement
// ===========================================================================

test("map.store is reactive for reads (Object.keys, JSON.stringify, in-operator)", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("a", 1);
    m.set("b", 2);
    assert.equal(m.store.a, 1);
    assert.equal(m.store.b, 2);
    assert.deepEqual(Object.keys(m.store).sort(), ["a", "b"]);
    assert.equal(JSON.stringify(m.store), '{"a":1,"b":2}');
    assert.equal("a" in m.store, true);
    assert.equal("z" in m.store, false);
    doc.dispose();
});

test("map.store blocks every direct-mutation path", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("a", 1);
    assert.throws(() => { m.store.b = 2; }, (e) => e instanceof CRDTError && e.code === "readonly");
    assert.throws(() => { delete m.store.a; }, (e) => e.code === "readonly");
    assert.throws(() => Object.defineProperty(m.store, "x", { value: 1 }), (e) => e.code === "readonly");
    // Underlying CRDT state must be untouched after the failed writes.
    assert.equal(m.get("a"), 1);
    assert.equal(m.has("b"), false);
    doc.dispose();
});

test("array.store is reactive for reads (index, length, for-of, JSON.stringify)", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const L = doc.array("L");
    L.push({ id: "1", v: "a" });
    L.push({ id: "2", v: "b" });
    assert.equal(L.store.length, 2);
    assert.deepEqual(L.store[0], { id: "1", v: "a" });
    const collected = [];
    for (const v of L.store) collected.push(v);
    assert.deepEqual(collected.map((v) => v.id), ["1", "2"]);
    assert.equal(JSON.stringify(L.store), '[{"id":"1","v":"a"},{"id":"2","v":"b"}]');
    doc.dispose();
});

test("array.store blocks every Array.prototype mutator and direct write", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const L = doc.array("L");
    L.push({ id: "1", v: "a" });
    const blow = (e) => e instanceof CRDTError && e.code === "readonly";
    assert.throws(() => L.store.push({ id: "x" }), blow);
    assert.throws(() => L.store.pop(), blow);
    assert.throws(() => L.store.shift(), blow);
    assert.throws(() => L.store.unshift({ id: "y" }), blow);
    assert.throws(() => L.store.splice(0, 1), blow);
    assert.throws(() => L.store.sort(), blow);
    assert.throws(() => L.store.reverse(), blow);
    assert.throws(() => L.store.fill(null), blow);
    assert.throws(() => L.store.copyWithin(0, 1), blow);
    assert.throws(() => { L.store[0] = { id: "x" }; }, blow);
    assert.throws(() => { L.store.length = 0; }, blow);
    // State unchanged after the failed mutations.
    assert.equal(L.size, 1);
    assert.deepEqual(L.values()[0], { id: "1", v: "a" });
    doc.dispose();
});

// ===========================================================================
// Reactivity contract (the central design claim of the library)
// ===========================================================================

test("map.get(key) is fine-grained reactive: an unrelated key change does NOT re-fire", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("theme", "dark");
    let runs = 0;
    const stop = effect(() => { runs++; void m.get("theme"); });
    assert.equal(runs, 1, "initial run");
    m.set("font", "mono");
    assert.equal(runs, 1, "unrelated key change must not re-fire a get(theme) effect");
    m.set("theme", "light");
    assert.equal(runs, 2, "the watched key changed -> re-fire");
    m.delete("theme");
    assert.equal(runs, 3, "delete of the watched key counts as a change");
    stop();
    doc.dispose();
});

test("map.has(key) is fine-grained reactive: unrelated key changes do NOT re-fire", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("theme", "dark");
    let runs = 0;
    const stop = effect(() => { runs++; void m.has("theme"); });
    assert.equal(runs, 1);
    m.set("font", "mono");
    assert.equal(runs, 1, "unrelated key must not re-fire has(theme)");
    m.delete("theme");
    assert.equal(runs, 2, "presence of watched key flipped");
    stop();
    doc.dispose();
});

test("map.store.someKey is fine-grained reactive (the binding pattern in the README)", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("theme", "dark");
    let runs = 0;
    const stop = effect(() => { runs++; void m.store.theme; });
    assert.equal(runs, 1);
    m.set("font", "mono");
    assert.equal(runs, 1, "unrelated key must not re-fire a store.theme effect");
    m.set("theme", "light");
    assert.equal(runs, 2);
    stop();
    doc.dispose();
});

test("map coarse reads (values/keys/entries/size) re-fire on ANY change", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    let valuesRuns = 0, sizeRuns = 0;
    const s1 = effect(() => { valuesRuns++; void m.values(); });
    const s2 = effect(() => { sizeRuns++; void m.size; });
    m.set("a", 1);
    m.set("b", 2);
    m.delete("a");
    assert.equal(valuesRuns, 4, "values() re-fires on every change");
    assert.equal(sizeRuns, 4);
    s1(); s2();
    doc.dispose();
});

test("array coarse reads (values/size/ids) re-fire on any change", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const L = doc.array("L");
    let runs = 0;
    const stop = effect(() => { runs++; void L.values(); });
    assert.equal(runs, 1);
    L.push({ id: "1", v: "a" });
    L.push({ id: "2", v: "b" });
    L.push({ id: "1", v: "edited" }); // an edit still counts as a change
    L.deleteById("2");
    assert.equal(runs, 5, "fires on add, add, edit, remove (4 changes after initial)");
    stop();
    doc.dispose();
});

test("a remote applyOp re-fires local reactive readers", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const opsA = [];
    A.on("op", (o) => opsA.push(o));
    let bRuns = 0;
    const stop = effect(() => { bRuns++; void B.map("m").get("k"); });
    assert.equal(bRuns, 1);
    A.map("m").set("k", "from-A");
    B.applyOp(opsA[0]);
    assert.equal(bRuns, 2, "B's reader re-fires when a remote op lands");
    stop();
    A.dispose(); B.dispose();
});

// ===========================================================================
// Post-dispose hygiene (regression for the collection-creation leak)
// ===========================================================================

test("dispose is idempotent (mixed states)", () => {
    const a = createCRDTDoc({ replicaId: "A" });
    assert.doesNotThrow(() => { a.dispose(); a.dispose(); a.dispose(); });

    const b = createCRDTDoc({ replicaId: "B" });
    b.map("m").set("a", 1);
    b.array("L").push({ id: "1", v: 1 });
    assert.doesNotThrow(() => { b.dispose(); b.dispose(); });
});

test("calling map()/array() after dispose throws instead of leaking a new collection", () => {
    // Regression for the v1.0.0-rc leak: getCollection auto-created a fresh
    // collection (and signal nodes) on a disposed doc, with no path to ever
    // reclaim those nodes. After the fix, post-dispose access is a clean
    // misconfigured throw.
    const doc = createCRDTDoc({ replicaId: "A" });
    doc.map("m").set("a", 1);
    doc.dispose();
    assert.throws(() => doc.map("m"), (e) => e instanceof CRDTError && e.code === "misconfigured");
    assert.throws(() => doc.array("L"), (e) => e instanceof CRDTError && e.code === "misconfigured");
});

test("applyOp / mergeState / snapshot after dispose stay silent (no throw, no work)", () => {
    // applyOp and mergeState are network-edge entry points; throwing on a
    // disposed doc would force every transport to add its own guard. Keep
    // them silent. snapshot/getState should likewise just return empty.
    const doc = createCRDTDoc({ replicaId: "A" });
    doc.map("m").set("a", 1);
    doc.dispose();
    assert.doesNotThrow(() => doc.applyOp({ t: "set", c: "m", k: "z", v: 9, l: 99, r: "Z" }));
    assert.doesNotThrow(() => doc.mergeState({ replicaId: "X", clock: 1, cols: {} }));
    assert.deepEqual(doc.snapshot(), {});
    assert.deepEqual(doc.getState().cols, {});
});

// ===========================================================================
// Pool reclamation (the regression guard for "no signal leaks")
// ===========================================================================

test("dispose reclaims signal nodes back to the lite-signal pool", () => {
    const before = stats();
    const doc = createCRDTDoc({ replicaId: "A" });
    doc.map("m").set("a", 1);
    doc.array("L").push({ id: "1", v: 1 });
    assert.ok(stats().signals > before.signals, "active during use");
    doc.dispose();
    assert.equal(stats().signals, before.signals, "all signals reclaimed");
    assert.equal(stats().activeNodes, before.activeNodes, "active node count back to baseline");
});

test("repeated create/dispose does not grow the active node pool", () => {
    const before = stats();
    let peak = 0;
    for (let i = 0; i < 500; i++) {
        const d = createCRDTDoc({ replicaId: "r" + i });
        d.map("m").set("k", i);
        d.array("L").push({ id: String(i), v: i });
        if (stats().activeNodes > peak) peak = stats().activeNodes;
        d.dispose();
    }
    assert.equal(stats().activeNodes, before.activeNodes, "all nodes reclaimed after 500 cycles");
    // While alive, the per-doc steady state should be bounded -- a regression
    // here means a single doc instance allocates an unexpected number of nodes.
    assert.ok(peak < 50, "peak active node count stayed bounded (saw " + peak + ")");
});

// ===========================================================================
// Hot-path heap-delta guard (engages only under --expose-gc)
// ===========================================================================

test("zero-GC: LWW-Map applyOp in steady state has near-zero heap growth",
    { skip: typeof globalThis.gc !== "function" ? "run with --expose-gc" : false },
    () => {
        const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };
        const doc = createCRDTDoc({ replicaId: "A" });
        // Warm V8 tiers and pre-populate the keyspace so every applyOp hits an
        // existing register (the in-place mutation branch).
        for (let i = 0; i < 5000; i++) {
            doc.applyOp({ t: "set", c: "m", k: "k" + (i & 31), v: i, l: i + 1, r: "Z" });
        }
        const before = heap();
        const N = 50_000;
        for (let i = 100_000; i < 100_000 + N; i++) {
            doc.applyOp({ t: "set", c: "m", k: "k" + (i & 31), v: i, l: i + 1, r: "Z" });
        }
        const after = heap();
        const delta = after - before;
        doc.dispose();
        assert.ok(delta < 200_000,
            "LWW applyOp grew heap " + delta + " bytes over " + N + " ops (expected ~0)");
    });

test("zero-GC: OR-Set edit (re-add of present id) has near-zero heap growth",
    { skip: typeof globalThis.gc !== "function" ? "run with --expose-gc" : false },
    () => {
        const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };
        const doc = createCRDTDoc({ replicaId: "A" });
        doc.on("op", () => {}); // exercise the emit path too
        const L = doc.array("L");
        for (let i = 0; i < 100; i++) L.push({ id: "i" + i, v: i });
        // Warm — edit existing ids; this exits via the `upd` branch with no
        // membership change. No new tag, no order recompute, no splice.
        for (let i = 0; i < 5000; i++) L.push({ id: "i" + (i % 100), v: i });
        const before = heap();
        const N = 20_000;
        for (let i = 100_000; i < 100_000 + N; i++) L.push({ id: "i" + (i % 100), v: i });
        const after = heap();
        const delta = after - before;
        doc.dispose();
        // Tighter bound than the LWW case: the documented OR-Set edit path
        // should NOT allocate beyond the op object itself.
        assert.ok(delta < 200_000,
            "OR-Set edit grew heap " + delta + " bytes over " + N + " ops (expected ~0)");
    });

test("zero-GC: dispatch to N op listeners does not allocate an iterator per fire",
    { skip: typeof globalThis.gc !== "function" ? "run with --expose-gc" : false },
    () => {
        // The doc comments call out that listener arrays are iterated by index
        // specifically to keep dispatch allocation-free. Catch a regression where
        // a future edit switches to for..of (which allocates an iterator).
        const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };
        const doc = createCRDTDoc({ replicaId: "A" });
        let sink = 0;
        for (let i = 0; i < 8; i++) doc.on("op", () => { sink++; });
        const m = doc.map("m");
        for (let i = 0; i < 5000; i++) m.set("k", i); // warm
        const before = heap();
        const N = 20_000;
        for (let i = 0; i < N; i++) m.set("k", i);
        const after = heap();
        const delta = after - before;
        doc.dispose();
        assert.ok(Number.isFinite(sink));
        // Per-fire necessary alloc is the op object (~80B) -- 20k * 80B is well
        // under the 2 MB bound. A per-fire iterator would push us much higher.
        assert.ok(delta < 2_000_000,
            "8-listener dispatch grew heap " + delta + " bytes over " + N + " fires");
    });
