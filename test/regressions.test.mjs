/**
 * Regression tests, one per finding, named by id (see ROADMAP.md sec. 3).
 *
 * The remote-boundary findings C-01..C-07 each assert the post-door behaviour:
 * a malformed remote op or merge payload is dropped and reported to onError,
 * never applied and never thrown out of applyOps/mergeState. Registered as todo
 * against v1.1.1 (fails-before), they now pass against the v1.1.2 door
 * (passes-after). Every assertion body is a runnable reproduction.
 *
 * Door policy: reject-and-continue (decisions/0001-remote-op-door.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

test("C-01: a remote op with l=Infinity must not poison the Lamport clock", () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    d.map("m").set("a", 1);
    d.applyOp({ t: "set", c: "m", k: "b", l: Infinity, r: "peer", v: 2 }); // must be rejected
    assert.ok(Number.isFinite(d.clock()), "clock went non-finite");
    d.map("m").set("c", 3);
    d.map("m").set("c", 4);
    assert.equal(d.map("m").get("c"), 4, "later local write lost -- clock is saturated");
    d.dispose();
});

test("C-02: a register written with l=NaN must not become permanently unwritable", () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    d.applyOp({ t: "set", c: "m", k: "k", l: NaN, r: "peer", v: "stuck" }); // must be rejected
    d.map("m").set("k", "fresh");
    assert.equal(d.map("m").get("k"), "fresh", "NaN-stamped register froze the key");
    d.dispose();
});

test("C-03: a remote counter op with a non-number cumulative must not poison the value", () => {
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

test("C-04: applyOp must reject a set op with a missing or non-number l", () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    d.map("m").set("seed", 0);
    const before = JSON.stringify(d.map("m").snapshot());
    d.applyOp({ t: "set", c: "m", k: "b", r: "peer", v: 1 });          // no l -> reject
    d.applyOp({ t: "set", c: "m", k: "b", l: "5", r: "peer", v: 1 });  // string l -> reject
    assert.equal(JSON.stringify(d.map("m").snapshot()), before, "a malformed op mutated state");
    d.dispose();
});

test("C-05: a kind-mismatched remote op must not throw out of applyOps", () => {
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

test("C-06: mergeState must not crash on a malformed payload", () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    assert.doesNotThrow(() => d.mergeState({ cols: { A: { kind: "set", adds: {}, values: {} } } })); // no `removed`
    d.dispose();
});

test("C-07: the Lamport clock must not silently freeze at 2^53", () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    d.applyOp({ t: "set", c: "m", k: "x", l: 2 ** 53, r: "peer", v: "remote" }); // must be rejected/bounded
    const c1 = d.clock();
    d.map("m").set("y", "a");
    assert.notEqual(d.clock(), c1, "clock did not advance after a local write");
    d.dispose();
});

test("C-15: mergeState with a set collection whose live add-id has no value register must not crash or self-poison", () => {
    // Includes prototype-name add-ids: `in` walks the proto chain, so "toString"
    // / "constructor" would pass a naive `!(id in values)` check even with no OWN
    // value entry -> the crash the door must reject (Object.hasOwn, not `in`).
    for (const badId of ["x", "toString", "constructor", "valueOf", "hasOwnProperty"]) {
        const errors = [];
        const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errors.push(e) });
        const poison = { cols: { A: { kind: "set", adds: { [badId]: { "peer#0": 5 } }, removed: [], values: {} } } };
        assert.doesNotThrow(() => d.mergeState(poison), "malformed set state crashed mergeState for id '" + badId + "'");
        assert.ok(errors.length >= 1, "the malformed collection ('" + badId + "') was not reported to onError");
        // The doc stays readable and structurally sound.
        assert.doesNotThrow(() => d.array("A").snapshot());
        assert.doesNotThrow(() => d.getState());
        // The poison must NOT have been absorbed: getState() re-emits no live
        // add-id lacking an OWN value register (own-property check, not `in`).
        const A = d.getState().cols.A;
        if (A) {
            for (const id in A.adds) {
                const tags = A.adds[id];
                let live = false; for (const _t in tags) { live = true; break; }
                assert.ok(!live || Object.hasOwn(A.values, id), "getState() re-emitted a live add-id '" + id + "' with no value register");
            }
        }
        d.dispose();
    }
});

test("C-16: applyOps must never throw on a malformed frame and must apply every good op", () => {
    const errors = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errors.push(e) });
    assert.doesNotThrow(() => d.applyOps([
        { t: "bogus", c: "m" },                                        // unknown op type -> would throw out of applyOp
        { t: "set", c: "m", k: "good", l: 5, r: "peer", v: 42 },       // good -> must still apply
    ]));
    assert.equal(d.map("m").get("good"), 42, "the good op after a bad frame was dropped");
    assert.ok(errors.length >= 1, "the bad frame was not reported to onError");
    // A single applyOp stays STRICT: an unknown op type still throws.
    assert.throws(() => d.applyOp({ t: "bogus", c: "m" }), (e) => e && e.code === "malformed_op");
    d.dispose();
});

test("C-17: a failed local write at the clock ceiling leaves no phantom undo record", () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    // Drive the clock to the ceiling via a valid remote op (the constructor
    // `clock` is int32-truncated, so it cannot seed a value this large).
    d.applyOp({ t: "set", c: "m", k: "seed", l: 2 ** 53 - 2, r: "peer", v: 1 });
    assert.equal(d.canUndo(), false, "a remote op must not record an undo");
    const before = JSON.stringify(d.map("m").snapshot());
    // The next local write ticks the clock past the ceiling -> tick() throws.
    assert.throws(() => d.map("m").set("k", "v"), (e) => e && e.code === "clock_ceiling");
    assert.equal(JSON.stringify(d.map("m").snapshot()), before, "a ceiling-failed write mutated state");
    assert.equal(d.canUndo(), false, "a ceiling-failed write left a phantom undo record");
    d.dispose();
});

test("C-18: a TOCTOU live-accessor payload cannot pass validation then poison the merge (mergeState)", () => {
    // The door read the same untrusted field twice (validate read, then merge
    // read). A live object (getter/Proxy) returned benign to the validator and
    // poison to the merge. The fix reads every untrusted scalar EXACTLY ONCE and
    // validates + merges from that same local, so the second (poison) read never
    // happens. Two scenarios prove it.

    // (a) benign-then-poison: the single read gets the benign value; the poison
    // second read is never taken. No non-finite lamport lands.
    {
        const errors = [];
        const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errors.push(e) });
        const values = {};
        let calls = 0;
        Object.defineProperty(values, "x", {
            enumerable: true,
            get() { calls++; return calls === 1 ? [1, "peer", "benign"] : [Infinity, "peer", "POISON"]; },
        });
        assert.doesNotThrow(() => d.mergeState({ cols: { A: { kind: "set", adds: { x: { "peer#0": 1 } }, removed: [], values } } }));
        const rec = d.getState().cols.A.values.x;
        assert.ok(rec === undefined || Number.isFinite(rec[0]), "value-register lamport went non-finite via a TOCTOU getter re-read");
        assert.equal(calls, 1, "the door read the untrusted register more than once (TOCTOU still open)");
        d.dispose();
    }

    // (b) always-poison: the single read is already poison -> dropped + reported,
    // no non-finite lamport, getState re-emits nothing poisoned.
    {
        const errors = [];
        const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errors.push(e) });
        const values = {};
        Object.defineProperty(values, "x", { enumerable: true, get() { return [Infinity, "peer", "POISON"]; } });
        assert.doesNotThrow(() => d.mergeState({ cols: { A: { kind: "set", adds: { x: { "peer#0": 1 } }, removed: [], values } } }));
        assert.ok(errors.length >= 1, "an always-poison register was silently absorbed");
        const A = d.getState().cols.A;
        if (A) for (const id in A.values) {
            assert.ok(Number.isFinite(A.values[id][0]), "getState() re-emitted a non-finite value-register lamport");
        }
        d.dispose();
    }
});

test("C-18: a TOCTOU live-accessor op cannot pass okOp then poison the clock/counter at use (applyOp)", () => {
    // Same class on the op door: okOp(op) read op.l/op.p, then the clock merge and
    // register write re-read them. A live accessor returned benign to okOp and
    // poison to use. The fix freezes the op into a single-read scratch first.

    // (a) map op with a benign-then-poison l: single read -> benign l=1 used for
    // both okOp and the register; the clock never goes non-finite.
    {
        const d = createCRDTDoc({ replicaId: "r1" });
        let calls = 0;
        const op = { t: "set", c: "m", k: "x", r: "peer", v: "V" };
        Object.defineProperty(op, "l", { enumerable: true, get() { calls++; return calls === 1 ? 1 : Infinity; } });
        assert.doesNotThrow(() => d.applyOp(op));
        assert.ok(Number.isFinite(d.clock()), "clock went non-finite via a TOCTOU op-l re-read");
        assert.equal(calls, 1, "the door read op.l more than once (TOCTOU still open)");
        d.dispose();
    }

    // (b) counter op with an always-poison p: single read is poison -> dropped +
    // reported; the counter value stays finite.
    {
        const errors = [];
        const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errors.push(e) });
        d.counter("c").inc(5);
        const op = { t: "cinc", c: "c", r: "peer" };
        Object.defineProperty(op, "p", { enumerable: true, get() { return Infinity; } });
        assert.doesNotThrow(() => d.applyOp(op));
        assert.ok(errors.length >= 1, "an always-poison counter op was silently absorbed");
        assert.ok(Number.isFinite(d.counter("c").peek()), "counter value went non-finite via a TOCTOU op-p re-read");
        assert.equal(d.counter("c").peek(), 5, "poison op changed the counter value");
        d.dispose();
    }
});

test("C-19: mergeState must advance the clock past every lamport it absorbs, so a later local write is not frozen out", () => {
    // (a) LWW-Map: a merged register with l=9 and clock=0 must advance the doc
    // clock, or the next local set emits l=1 and silently loses to the l=9 register.
    {
        const d = createCRDTDoc({ replicaId: "r1" });
        d.mergeState({ clock: 0, cols: { m: { kind: "map", entries: { x: [9, "peer", 0, "remote"] } } } });
        assert.ok(d.clock() >= 9, "clock did not advance past the absorbed register lamport: " + d.clock());
        d.map("m").set("x", "MY_LOCAL_EDIT");
        assert.equal(d.map("m").get("x"), "MY_LOCAL_EDIT", "a later local write lost to a merged register (clock frozen)");
        d.dispose();
    }
    // (b) OR-Set: a high tag/value lamport must advance the clock the same way.
    {
        const d = createCRDTDoc({ replicaId: "r1" });
        d.mergeState({ clock: 0, cols: { A: { kind: "set", adds: { u: { "peer#0": 12 } }, removed: [], values: { u: [12, "peer", "remote"] } } } });
        assert.ok(d.clock() >= 12, "clock did not advance past the absorbed OR-Set lamport: " + d.clock());
        d.array("A").add({ id: "u", v: "MY_LOCAL_EDIT" });
        assert.equal(d.array("A").get("u").v, "MY_LOCAL_EDIT", "a later local OR-Set edit lost to a merged value (clock frozen)");
        d.dispose();
    }
    // (c) near-ceiling: a register at 2^53-1 must end fail-CLOSED -- the next local
    // write throws clock_ceiling LOUDLY, never silently loses.
    {
        const d = createCRDTDoc({ replicaId: "r1" });
        d.mergeState({ clock: 0, cols: { m: { kind: "map", entries: { x: [2 ** 53 - 1, "peer", 0, "remote"] } } } });
        assert.ok(d.clock() >= 2 ** 53 - 1, "clock did not advance to the near-ceiling register lamport");
        assert.throws(() => d.map("m").set("x", "LOCAL"), (e) => e && e.code === "clock_ceiling");
        d.dispose();
    }
    // (d) an over-ceiling register lamport (>= 2^53) is dropped+reported, and the
    // clock is NOT advanced by it (stays representable).
    {
        const errors = [];
        const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errors.push(e) });
        d.mergeState({ clock: 0, cols: { m: { kind: "map", entries: { x: [2 ** 53, "peer", 0, "remote"] } } } });
        assert.ok(errors.length >= 1, "an over-ceiling register lamport was not dropped+reported");
        assert.ok(d.clock() < 2 ** 53, "clock advanced to/past the ceiling from a dropped register");
        assert.equal(d.map("m").get("x"), undefined, "an over-ceiling register was absorbed");
        d.dispose();
    }
});

test("C-10: churning one id add/delete must not retain an empty adds entry, but must keep its value register", () => {
    // Retention (decisions/0002): when an id's last live tag is removed, its adds
    // entry is a dead empty Map and is dropped -- so adds is O(live ids), not
    // O(ops). valueReg is KEPT deliberately: it carries the max-lamport (l, r)
    // register, and dropping it would let a later lower-l add/upd win and diverge.
    const d = createCRDTDoc({ replicaId: "R" });
    const arr = d.array("bag");
    const before = arr._retention();
    assert.deepEqual(before, { adds: 0, valueReg: 0, removed: 0 }, "fresh OR-Set is not empty");
    for (let i = 0; i < 10000; i++) {
        arr.add({ id: "same", n: i });
        arr.deleteById("same");
    }
    const after = arr._retention();
    // The retention win, made visible: 10k add/delete cycles of ONE id leave zero
    // adds entries (the emptied Map is dropped, not retained) and exactly one
    // value register (kept, for convergence).
    assert.equal(after.adds, 0, "adds retained a dead empty entry after delete (leak): adds.size=" + after.adds);
    assert.equal(after.valueReg, 1, "value register was dropped (convergence hazard): valueReg.size=" + after.valueReg);
    // Publicly observable: the id is no longer a member, its value register survives.
    const st = d.getState().cols.bag;
    assert.equal(Object.keys(st.adds).length, 0, "getState re-emitted a live add entry for a deleted id");
    assert.equal(Object.keys(st.values).length, 1, "getState dropped the retained value register");
    assert.equal(d.array("bag").hasId("same"), false, "deleted id still reports as a member");
    d.dispose();
});

test("C-11: two replicas converging on the same ops emit byte-identical snapshot() and getState() regardless of collection-creation order", () => {
    // snapshot()/getState() are now replica-independent: the doc sorts its
    // top-level collection names and each collection sorts its own keys. So the
    // torture canon() shim is gone -- raw JSON.stringify(snapshot()) compares equal.
    const ops = [
        { t: "set", c: "zeta", k: "x", l: 1, r: "p", v: 1 },
        { t: "set", c: "alpha", k: "y", l: 2, r: "p", v: 2 },
        { t: "add", c: "arr", id: "i1", n: 0, v: { id: "i1", n: 5 }, l: 3, r: "p" },
        { t: "set", c: "mid", k: "z", l: 4, r: "p", v: 3 },
        { t: "add", c: "arr", id: "i2", n: 1, v: { id: "i2", n: 6 }, l: 5, r: "p" },
        { t: "cinc", c: "votes", r: "p", p: 7 },
    ];
    // Same replicaId so getState()'s top-level replicaId/clock also match; the ops
    // carry their own r, so this is purely a receive-side convergence.
    const a = createCRDTDoc({ replicaId: "R" });
    const b = createCRDTDoc({ replicaId: "R" });
    for (let i = 0; i < ops.length; i++) a.applyOp(ops[i]);
    for (let i = ops.length - 1; i >= 0; i--) b.applyOp(ops[i]);   // reversed => different creation order
    // No canon shim: the raw stringify must already be equal.
    assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()), "snapshot() diverged on collection-creation order");
    assert.equal(JSON.stringify(a.getState()), JSON.stringify(b.getState()), "getState() diverged on collection-creation order");
    a.dispose();
    b.dispose();
});

test("C-12: a __proto__ collection name AND a __proto__ element id round-trip getState -> mergeState without prototype pollution", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    // Collection named "__proto__", holding an element whose id is "__proto__".
    d.array("__proto__").add({ id: "__proto__", n: 42 });
    const state = d.getState();
    // Object.create(null) makes both the collection name and the element id OWN
    // keys instead of retargeting a prototype -- so the data actually survives.
    assert.ok(Object.hasOwn(state.cols, "__proto__"), "the __proto__ collection was lost (name clobbered a prototype)");
    const col = state.cols["__proto__"];
    assert.ok(Object.hasOwn(col.adds, "__proto__"), "the __proto__ element id was lost from adds");
    assert.ok(Object.hasOwn(col.values, "__proto__"), "the __proto__ element id was lost from values");
    // Round-trip into a fresh doc.
    const d2 = createCRDTDoc({ replicaId: "R2" });
    d2.mergeState(state);
    const got = d2.array("__proto__").get("__proto__");
    assert.equal(got && got.n, 42, "the __proto__/__proto__ element did not survive the round-trip");
    // No prototype pollution: neither building nor merging the state touched a shared prototype.
    assert.equal(({}).polluted, undefined, "Object.prototype was polluted");
    assert.equal(Object.getPrototypeOf({}), Object.prototype, "a fresh object's prototype changed");
    d.dispose();
    d2.dispose();
});

test("C-12: a __proto__ replicaId on a PN-Counter round-trips getState -> mergeState without divergence", () => {
    // The counter is keyed by replicaId, which is caller-supplied and reaches P/N
    // both remotely (okOp accepts r="__proto__": string, length>0) and locally (a
    // doc replicaId is unvalidated). On a plain {} serializer, p["__proto__"]=<n>
    // hits the __proto__ setter, which silently drops a non-object value -> the
    // entry vanishes and the peer diverges with zero onError. Object.create(null)
    // makes it an own key that round-trips.
    const errors = [];
    const a = createCRDTDoc({ replicaId: "R", onError: (e) => errors.push(e) });
    // A crafted remote cinc under a "__proto__" replicaId (the remote axis)...
    a.applyOp({ t: "cinc", c: "votes", r: "__proto__", p: 5 });
    // ...plus a local edit under the doc's own "__proto__" replica (the local axis).
    const b = createCRDTDoc({ replicaId: "__proto__" });
    b.counter("votes").inc(3);
    // Cross-merge and assert both replicas converge on the same value.
    const sa = a.getState();
    assert.ok(Object.hasOwn(sa.cols.votes.p, "__proto__"), "the __proto__ replica cumulative was dropped from serialized state");
    const merged = createCRDTDoc({ replicaId: "M" });
    merged.mergeState(sa);
    merged.mergeState(b.getState());
    // R saw p[__proto__]=5, B (as replica __proto__) saw p[__proto__]=3; max wins => 5.
    assert.equal(a.counter("votes").value(), 5, "counter A diverged");
    assert.equal(merged.counter("votes").value(), 5, "merged replica diverged from the source counter");
    assert.equal(errors.length, 0, "a well-formed __proto__ replicaId op was wrongly reported to onError");
    // No prototype pollution from either build or merge.
    assert.equal(({}).polluted, undefined, "Object.prototype was polluted");
    assert.equal(Object.getPrototypeOf({}), Object.prototype, "a fresh object's prototype changed");
    a.dispose();
    b.dispose();
    merged.dispose();
});

test("C-13: undo of an OR-Set removal restores membership + value, NOT list position (contract, decisions/0003)", () => {
    // This test ENCODES the decided contract (option (a)). A future change to
    // undo ordering must break THIS test, not silently alter behaviour.
    const d = createCRDTDoc({ replicaId: "A" });
    const a = d.array("L");
    a.add({ id: "1", v: "one" });
    a.add({ id: "2", v: "two" });
    assert.deepEqual(a.values().map((v) => v.id), ["1", "2"], "initial insertion order");
    a.deleteById("1");
    assert.equal(a.hasId("1"), false, "id 1 removed");
    d.undo();
    // Membership {1,2} is restored...
    assert.equal(a.size, 2, "both ids live after undo");
    assert.equal(a.hasId("1"), true, "membership of id 1 restored");
    assert.equal(a.hasId("2"), true, "id 2 still live");
    // ...value is restored...
    assert.equal(a.get("1").v, "one", "value of id 1 restored");
    assert.equal(a.get("2").v, "two", "value of id 2 unchanged");
    // ...but POSITION is NOT: undo mints a fresh tag, so id 1 reappears LAST,
    // re-timed after id 2. The order is [2, 1], not the original [1, 2].
    assert.deepEqual(a.values().map((v) => v.id), ["2", "1"],
        "undo re-times element order: id 1 reappears last (fresh tag / new order key)");
    d.dispose();
});
