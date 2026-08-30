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
