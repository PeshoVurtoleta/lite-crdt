/**
 * Torture / adversarial regression suite for @zakkster/lite-crdt.
 *
 * Every test here pins a defect found during the v1.1.0 prepublish review, or a
 * limit that is deliberately NOT fixed and must therefore not drift silently.
 *
 * Design notes that matter if you extend this file:
 *
 *  - CONVERGENCE IS COMPARED ON VALUES, NOT KEY ORDER -- until it isn't. The
 *    first version of this fuzzer compared JSON.stringify(snapshot) directly and
 *    reported 385/400 "divergent" seeds that were nothing but map key insertion
 *    order. Key order is now normalised by the library itself, so both the value
 *    oracle and the order oracle are asserted, separately and on purpose.
 *
 *  - POOL TESTS INSTALL A FIXED CEILING. A registry with onCapacityExceeded:
 *    "grow" turns a hard node leak into an invisible bleed. The feed test below
 *    only catches the lite-store shrink-path leak because the ceiling is hard.
 *
 *  - THE FEED TEST BINDS PER-ROW FIELDS, not just .length. Tracking only the
 *    array length allocates 3 nodes total and passes against a badly leaking
 *    store; the leak lives on the per-row signals.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, setDefaultRegistry, stats, effect } from "@zakkster/lite-signal";
import { createCRDTDoc, CRDTError } from "../CRDT.js";

/* -- helpers ---------------------------------------------------------------- */

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Run `fn` against an isolated fixed-ceiling registry, then hand the pool back. */
function inRegistry(config, fn) {
    setDefaultRegistry(createRegistry(config));
    try { return fn(); } finally { setDefaultRegistry(createRegistry({ maxNodes: 1 << 20, onCapacityExceeded: "grow" })); }
}

/** A realistic transport: ops crossing a wire are serialised, not shared. */
const wireOps = (ops) => JSON.parse(JSON.stringify(ops));

const valueView = (doc) => JSON.stringify({
    m: doc.map("m").snapshot(),
    l: doc.array("l").snapshot(),
    c: doc.counter("c").peek(),
});

/* -- 1. OR-Set tag parsing: replicaId may contain the separator ------------- */

test("replicaIds containing '#' still converge", () => {
    // tagKey is `replicaId + "#" + counter`, and the order key was recovered with
    // indexOf("#") -- so "team#alice" and "team#bob" both parsed to "team",
    // collapsing two replicas onto one order key. List order inverted between
    // peers: P saw [p1,q1] while Q saw [q1,p1], permanently.
    for (const [a, b] of [["team#alice", "team#bob"], ["u#1", "u#2"], ["x#y", "x#z"]]) {
        const P = createCRDTDoc({ replicaId: a, undoDepth: 0 });
        const Q = createCRDTDoc({ replicaId: b, undoDepth: 0 });
        const opsP = [], opsQ = [];
        P.on("op", (o) => opsP.push(o));
        Q.on("op", (o) => opsQ.push(o));
        P.array("l").add({ id: "p1" });          // concurrent: same lamport, no sync yet
        Q.array("l").add({ id: "q1" });
        P.applyOps(wireOps(opsQ));
        Q.applyOps(wireOps(opsP));
        const sp = P.array("l").snapshot().map((x) => x.id).join(",");
        const sq = Q.array("l").snapshot().map((x) => x.id).join(",");
        assert.equal(sp, sq, `replicaIds ${a}/${b} diverged: [${sp}] vs [${sq}]`);
        P.dispose(); Q.dispose();
    }
});

/* -- 2. The read-only projection must be deep ------------------------------- */

test("map .store guard is deep, not one level", () => {
    // A one-level proxy handed the child store proxy back raw, so this mutated
    // CRDT state, fired local reactivity and emitted NO op.
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("cfg", { theme: "dark", nested: { deep: 1 } });
    assert.throws(() => { m.store.cfg = "x"; }, CRDTError, "top-level write must be blocked");
    assert.throws(() => { m.store.cfg.theme = "light"; }, CRDTError, "nested write must be blocked");
    assert.throws(() => { m.store.cfg.nested.deep = 2; }, CRDTError, "deep write must be blocked");
    assert.throws(() => { delete m.store.cfg.theme; }, CRDTError, "nested delete must be blocked");
    assert.equal(m.get("cfg").theme, "dark", "state must be untouched");
    doc.dispose();
});

test("array .store guard covers nested rows and nested arrays", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const a = doc.array("rows");
    a.add({ id: "r1", label: "one", tags: ["x"] });
    assert.throws(() => { a.store.push({ id: "r2" }); }, CRDTError);
    assert.throws(() => { a.store[0].label = "hacked"; }, CRDTError, "row field write must be blocked");
    assert.throws(() => { a.store[0].tags.push("y"); }, CRDTError, "nested array mutator must be blocked");
    assert.equal(a.store[0].label, "one");
    doc.dispose();
});

test("read APIs do not hand out mutable internals", () => {
    // get()/values()/entries() reached around the guard: get() returned the raw
    // store proxy, values()/entries() returned the unwrapped target objects.
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("cfg", { theme: "dark" });
    assert.throws(() => { m.get("cfg").theme = "via-get"; }, CRDTError, "map.get(k) must be read-only");
    assert.throws(() => { m.values()[0].theme = "via-values"; }, CRDTError, "values() must be read-only");
    assert.throws(() => { m.entries()[0][1].theme = "via-entries"; }, CRDTError, "entries() must be read-only");
    assert.equal(m.get("cfg").theme, "dark");
    doc.dispose();
});

test("OR-Set read APIs do not hand out mutable internals either", () => {
    // The map's get()/values()/entries() were wrapped, but the OR-Set's were not:
    // `roWrap` was destructured in createORSet and never applied, so array().get()
    // returned the raw stored value and values() returned the unwrapped targets.
    // Writing through either mutated CRDT state and emitted NO op -- the same
    // silent desync the .store guard exists to prevent, reached by another door.
    const doc = createCRDTDoc({ replicaId: "A" });
    const a = doc.array("L");
    a.push({ id: "r1", cfg: { theme: "dark" } });
    assert.throws(() => { a.get("r1").cfg.theme = "via-get"; }, CRDTError, "array.get(id) must be read-only");
    assert.throws(() => { a.get("r1").id = "via-get-scalar"; }, CRDTError, "array.get(id) must be read-only at the top level too");
    assert.throws(() => { a.values()[0].cfg.theme = "via-values"; }, CRDTError, "array values() must be read-only");
    assert.deepEqual(a.snapshot(), [{ id: "r1", cfg: { theme: "dark" } }], "state survived the write attempts");

    // The documented edit pattern (read a row, spread it, push it back) must keep
    // working through the wrapper -- it is what the demo and the README use.
    const cur = a.get("r1");
    a.push({ ...cur, cfg: { theme: "light" } });
    assert.equal(a.get("r1").cfg.theme, "light", "get -> spread -> push round-trip still works");
    doc.dispose();
});

test("nested-write attempt cannot silently desync a peer", () => {
    const A = createCRDTDoc({ replicaId: "A" }), B = createCRDTDoc({ replicaId: "B" });
    A.on("ops", (ops) => B.applyOps(wireOps(ops)));
    B.on("ops", (ops) => A.applyOps(wireOps(ops)));
    A.map("m").set("cfg", { theme: "dark" });
    assert.throws(() => { A.map("m").store.cfg.theme = "light"; }, CRDTError);
    A.map("m").set("unrelated", 1);
    assert.equal(
        JSON.stringify(A.map("m").snapshot()),
        JSON.stringify(B.map("m").snapshot()),
        "replicas diverged after a bypassed nested write",
    );
    A.dispose(); B.dispose();
});

test("read-only wrappers keep a stable identity", () => {
    // Wrapping must be cached: a fresh Proxy per read would allocate on the
    // hottest path there is (a render loop) and break `===` keying.
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("cfg", { theme: "dark" });
    assert.equal(m.store.cfg, m.store.cfg, "nested view identity must be stable");
    assert.equal(m.get("cfg"), m.get("cfg"), "get() identity must be stable");
    doc.dispose();
});

/* -- 3. PN-counter argument handling ---------------------------------------- */

test("counter rejects arguments it would otherwise silently corrupt", () => {
    // `by | 0`: inc(2.5) counted 2, inc(1e10) WRAPPED to 1410065408, and
    // inc(2**31) / inc(NaN) / inc(Infinity) were silent no-ops.
    const doc = createCRDTDoc({ replicaId: "A" });
    const c = doc.counter("c");
    for (const bad of [2.5, NaN, Infinity, -Infinity, "3", {}, 2 ** 53]) {
        assert.throws(() => c.inc(bad), CRDTError, `inc(${String(bad)}) must throw, not miscount`);
        assert.throws(() => c.dec(bad), CRDTError, `dec(${String(bad)}) must throw, not miscount`);
    }
    assert.equal(c.peek(), 0, "no failed call may have moved the counter");
    doc.dispose();
});

test("counter handles large-but-safe integers exactly", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const c = doc.counter("c");
    c.inc(1e10);
    assert.equal(c.peek(), 1e10, "1e10 must not wrap through int32");
    c.inc(2 ** 31);
    assert.equal(c.peek(), 1e10 + 2 ** 31, "2**31 must not be a silent no-op");
    doc.dispose();
});

test("counter keeps its documented non-positive no-op contract", () => {
    // llms.txt: "non-positive `by` is ignored". Not a bug -- pinned so the
    // stricter validation above cannot accidentally start throwing here.
    const doc = createCRDTDoc({ replicaId: "A" });
    const c = doc.counter("c");
    c.inc(); c.inc(0); c.inc(-3); c.dec();
    assert.equal(c.peek(), 0);
    doc.dispose();
});

/* -- 4. '__proto__' as a map key -------------------------------------------- */

test("'__proto__' is rejected locally rather than silently dropped", () => {
    // proj["__proto__"] = v retargets the projection's prototype instead of
    // creating an own key, so set() reported success and the key then failed to
    // appear in get(), keys(), snapshot() or getState().
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    assert.throws(() => m.set("__proto__", "danger"), CRDTError);
    assert.throws(() => m.delete("__proto__"), CRDTError);
    m.set("safe", 1);
    assert.deepEqual(m.keys(), ["safe"]);
    doc.dispose();
});

test("a hostile remote '__proto__' op is inert and cannot crash the doc", () => {
    // Remote ops must NOT throw -- a peer could otherwise kill the document with
    // one crafted frame. They are ignored instead.
    const doc = createCRDTDoc({ replicaId: "A" });
    doc.map("m").set("ok", "v");
    assert.doesNotThrow(() => {
        doc.applyOp(JSON.parse('{"t":"set","c":"m","k":"__proto__","v":{"pwned":1},"l":99,"r":"evil"}'));
    });
    assert.equal({}.pwned, undefined, "Object.prototype polluted");
    assert.deepEqual(doc.map("m").keys(), ["ok"]);
    assert.equal(JSON.stringify(doc.map("m").snapshot()), '{"ok":"v"}');
    doc.dispose();
});

test("hostile mergeState payload is inert", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    assert.doesNotThrow(() => doc.mergeState(JSON.parse(
        '{"clock":5,"cols":{"m":{"kind":"map","entries":{"__proto__":[9,"z",0,{"pwned":1}],"ok":[1,"a",0,"v"]}}}}',
    )));
    assert.equal({}.pwned, undefined);
    assert.deepEqual(doc.map("m").keys(), ["ok"]);
    doc.dispose();
});

/* -- 5. Replica-independent read order -------------------------------------- */

test("map read APIs are ordered identically on every replica", () => {
    // Converged replicas learn the same keys in different orders, so raw
    // insertion order disagreed on 385/400 fuzz seeds. A list rendered from
    // entries() would sit in a different order on each peer.
    const rnd = mulberry32(7);
    const KEYS = ["delta", "alpha", "charlie", "bravo", "echo"];
    const A = createCRDTDoc({ replicaId: "A", undoDepth: 0 });
    const B = createCRDTDoc({ replicaId: "B", undoDepth: 0 });
    const outA = [], outB = [];
    A.on("ops", (o) => outA.push(...wireOps(o)));
    B.on("ops", (o) => outB.push(...wireOps(o)));
    for (let i = 0; i < 40; i++) {
        (rnd() < 0.5 ? A : B).map("m").set(KEYS[(rnd() * KEYS.length) | 0], (rnd() * 100) | 0);
    }
    A.applyOps(outB); B.applyOps(outA);
    assert.deepEqual(A.map("m").keys(), B.map("m").keys(), "keys() order differs across replicas");
    assert.deepEqual(A.map("m").entries(), B.map("m").entries(), "entries() order differs across replicas");
    assert.equal(
        JSON.stringify(A.map("m").snapshot()),
        JSON.stringify(B.map("m").snapshot()),
        "snapshot() key order differs across replicas",
    );
    A.dispose(); B.dispose();
});

/* -- 6. Convergence under adversarial delivery ------------------------------ */

function convergenceRun(seed, replicaIds) {
    const rnd = mulberry32(seed);
    const KEYS = ["a", "b", "c", "d"], IDS = ["x", "y", "z"];
    const docs = replicaIds.map((id) => createCRDTDoc({ replicaId: id, undoDepth: 0 }));
    const outbox = docs.map(() => []);
    docs.forEach((d, i) => d.on("ops", (ops) => outbox[i].push(...wireOps(ops))));

    for (let r = 0; r < 60; r++) {
        const d = docs[(rnd() * docs.length) | 0];
        const roll = rnd();
        if (roll < 0.30) d.map("m").set(KEYS[(rnd() * KEYS.length) | 0], (rnd() * 100) | 0);
        else if (roll < 0.42) d.map("m").delete(KEYS[(rnd() * KEYS.length) | 0]);
        else if (roll < 0.62) d.array("l").add({ id: IDS[(rnd() * IDS.length) | 0], v: (rnd() * 100) | 0 });
        else if (roll < 0.74) d.array("l").deleteById(IDS[(rnd() * IDS.length) | 0]);
        else if (roll < 0.86) d.counter("c").inc(1 + ((rnd() * 3) | 0));
        else if (roll < 0.94) d.counter("c").dec(1 + ((rnd() * 3) | 0));
        else d.transact(() => { d.map("m").set("t", (rnd() * 100) | 0); d.array("l").add({ id: IDS[0], v: 1 }); });
    }

    const deliveries = [];
    for (let src = 0; src < docs.length; src++) {
        for (let dst = 0; dst < docs.length; dst++) {
            if (src === dst) continue;
            for (const op of outbox[src]) {
                deliveries.push([dst, op]);
                if (rnd() < 0.25) deliveries.push([dst, op]);   // redelivery is idempotent
            }
        }
    }
    for (let i = deliveries.length - 1; i > 0; i--) {           // shuffle: order must not matter
        const j = (rnd() * (i + 1)) | 0;
        const t = deliveries[i]; deliveries[i] = deliveries[j]; deliveries[j] = t;
    }
    for (const [dst, op] of deliveries) docs[dst].applyOp(op);

    const views = docs.map(valueView);
    const orders = docs.map((d) => d.map("m").keys().join(","));
    docs.forEach((d) => d.dispose());
    return { views, orders };
}

test("400 seeds converge under shuffled + duplicated delivery", () => {
    for (let seed = 1; seed <= 400; seed++) {
        const { views, orders } = convergenceRun(seed, ["R0", "R1", "R2"]);
        assert.ok(views.every((v) => v === views[0]), `seed ${seed} diverged:\n  ${views.join("\n  ")}`);
        assert.ok(orders.every((o) => o === orders[0]), `seed ${seed} key order differs: ${orders.join(" | ")}`);
    }
});

test("200 seeds converge with '#' in every replicaId", () => {
    for (let seed = 1; seed <= 200; seed++) {
        const { views } = convergenceRun(seed, ["team#a", "team#b", "team#c"]);
        assert.ok(views.every((v) => v === views[0]), `seed ${seed} diverged with '#' replicaIds`);
    }
});

test("a state-sync late joiner lands exactly where the op-sync peers are", () => {
    const KEYS = ["a", "b", "c", "d"], IDS = ["x", "y", "z"];
    for (let seed = 1; seed <= 200; seed++) {
        const rnd = mulberry32(seed ^ 0x5eed);
        const A = createCRDTDoc({ replicaId: "A", undoDepth: 0 });
        const B = createCRDTDoc({ replicaId: "B", undoDepth: 0 });
        A.on("ops", (ops) => B.applyOps(wireOps(ops)));
        B.on("ops", (ops) => A.applyOps(wireOps(ops)));
        for (let r = 0; r < 40; r++) {
            const d = rnd() < 0.5 ? A : B;
            const roll = rnd();
            if (roll < 0.35) d.map("m").set(KEYS[(rnd() * KEYS.length) | 0], (rnd() * 100) | 0);
            else if (roll < 0.5) d.map("m").delete(KEYS[(rnd() * KEYS.length) | 0]);
            else if (roll < 0.75) d.array("l").add({ id: IDS[(rnd() * IDS.length) | 0], v: (rnd() * 100) | 0 });
            else if (roll < 0.9) d.array("l").deleteById(IDS[(rnd() * IDS.length) | 0]);
            else d.counter("c").inc(1);
        }
        const C = createCRDTDoc({ replicaId: "C", undoDepth: 0 });
        C.mergeState(JSON.parse(JSON.stringify(A.getState())));
        assert.equal(valueView(C), valueView(A), `seed ${seed}: late joiner mismatched the op-sync peer`);
        A.dispose(); B.dispose(); C.dispose();
    }
});

/* -- 7. Signal-pool accounting ---------------------------------------------- */

test("a rendered bounded feed holds a flat node ledger", () => {
    // THE headline use case: a live list bound per-row. On lite-store v1.1.0
    // every OR-Set removal went through proj.splice(), which fired the right
    // signals but never released the departed row's nodes -- this hard-crashed
    // with CapacityError at ~4,000 ticks while the live set never exceeded 50.
    // Requires a lite-store with the shrink-path disposal fix.
    inRegistry({ maxNodes: 4096 }, () => {
        const doc = createCRDTDoc({ replicaId: "A", undoDepth: 0 });
        const a = doc.array("feed");
        const stop = effect(() => {
            const v = a.store;
            for (let i = 0; i < v.length; i++) void v[i].text;
        });
        let settled = 0;
        for (let i = 0; i < 8000; i++) {
            a.add({ id: "m" + i, text: "hello" });
            if (a.size > 50) a.deleteById("m" + (i - 50));
            if (i === 999) settled = stats().activeNodes;
        }
        const end = stats().activeNodes;
        assert.equal(end, settled, `node ledger drifted: ${settled} -> ${end} while the feed stayed at 50 rows`);
        stop(); doc.dispose();
    });
});

test("doc.dispose() returns every node the document took", () => {
    inRegistry({ maxNodes: 8192 }, () => {
        const base = stats().activeNodes;
        const doc = createCRDTDoc({ replicaId: "A" });
        const m = doc.map("m"), a = doc.array("l"), c = doc.counter("c");
        for (let i = 0; i < 50; i++) { m.set("k" + i, i); a.add({ id: "i" + i }); c.inc(); }
        const stop = effect(() => { void m.get("k1"); void a.store.length; void c.value(); });
        stop();
        doc.dispose();
        assert.equal(stats().activeNodes, base, "doc.dispose() leaked nodes");
    });
});

test("repeated create/dispose cycles do not accumulate nodes", () => {
    inRegistry({ maxNodes: 8192 }, () => {
        const base = stats().activeNodes;
        for (let r = 0; r < 200; r++) {
            const doc = createCRDTDoc({ replicaId: "r" + r });
            const m = doc.map("m");
            for (let i = 0; i < 10; i++) m.set("k" + i, i);
            doc.dispose();
        }
        assert.equal(stats().activeNodes, base, "create/dispose cycles leaked nodes");
    });
});

/* -- 8. Documented limits -- pinned, NOT fixed ------------------------------- */

test("LIMIT: values are stored by reference, so a retained object aliases state", () => {
    // set(k, obj) keeps the caller's object. Mutating it afterwards changes CRDT
    // state with no op emitted. Cloning every value on write was rejected: it
    // costs an allocation on the hottest path in the library. Callers must not
    // retain a reference -- or must pass a fresh object.
    const doc = createCRDTDoc({ replicaId: "A" });
    const cfg = { theme: "dark" };
    doc.map("m").set("cfg", cfg);
    cfg.theme = "mutated by caller";
    assert.equal(doc.map("m").get("cfg").theme, "mutated by caller",
        "aliasing semantics changed -- update the docs deliberately");
    doc.dispose();
});

test("LIMIT: in-process peers share op payload objects", () => {
    // Wiring two docs together without serialising means both hold the SAME
    // value object, so a mutation through one is visible in the other with no op
    // -- and tests that skip JSON pass while a real transport diverges. Any
    // in-process transport must clone (structuredClone/JSON) on the boundary.
    const A = createCRDTDoc({ replicaId: "A" }), B = createCRDTDoc({ replicaId: "B" });
    A.on("ops", (ops) => B.applyOps(ops));            // deliberately NOT serialised
    const cfg = { theme: "dark" };
    A.map("m").set("cfg", cfg);
    cfg.theme = "mutated";                            // one write, two documents
    assert.equal(A.map("m").get("cfg").theme, "mutated");
    assert.equal(B.map("m").get("cfg").theme, "mutated",
        "op payload aliasing changed -- update the docs deliberately");
    // ...and a serialising transport does NOT share, which is the fix.
    const C = createCRDTDoc({ replicaId: "C" }), D = createCRDTDoc({ replicaId: "D" });
    C.on("ops", (ops) => D.applyOps(wireOps(ops)));
    const cfg2 = { theme: "dark" };
    C.map("m").set("cfg", cfg2);
    cfg2.theme = "mutated";
    assert.equal(D.map("m").get("cfg").theme, "dark", "a serialised transport must not alias");
    A.dispose(); B.dispose(); C.dispose(); D.dispose();
});

test("LIMIT: tombstones are never collected, so state grows without bound", () => {
    // Classic observed-remove cost: `removed` tags, empty `adds` entries and
    // `valueReg` records all survive removal. 20k add/remove ticks at a cap of
    // 50 live rows produced >1 MB of getState(). There is no compaction API; a
    // long-lived feed needs a periodic rebuild from snapshot instead.
    const doc = createCRDTDoc({ replicaId: "A", undoDepth: 0 });
    const a = doc.array("feed");
    const sizeAt = [];
    for (let i = 0; i < 4000; i++) {
        a.add({ id: "m" + i, text: "x" });
        if (a.size > 50) a.deleteById("m" + (i - 50));
        if (i === 999 || i === 3999) sizeAt.push(JSON.stringify(doc.getState().cols.feed).length);
    }
    assert.equal(a.size, 50, "live set should be capped");
    assert.ok(sizeAt[1] > sizeAt[0] * 2,
        `state stopped growing (${sizeAt[0]} -> ${sizeAt[1]}) -- if tombstone GC was added, replace this pin`);
    doc.dispose();
});

test("LIMIT: undo granularity is per-op, not per-transaction", () => {
    // transact() is atomic for the network (one frame) but not for history: a
    // 3-op transaction needs 3 undos and re-emits 3 separate frames.
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    doc.transact(() => { m.set("a", 1); m.set("b", 2); m.set("c", 3); });
    let frames = 0;
    doc.on("ops", () => frames++);
    doc.undo();
    assert.deepEqual(m.keys(), ["a", "b"], "one undo should reverse exactly one op");
    doc.undo(); doc.undo();
    assert.deepEqual(m.keys(), [], "three undos reverse the whole transaction");
    assert.equal(frames, 3, "undo re-emits one frame per op, not one per transaction");
    doc.dispose();
});
