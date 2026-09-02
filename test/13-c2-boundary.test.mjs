/**
 * QA session C2, independent boundary verification.
 *
 * These tests do NOT trust the coder's report or the regression tests already
 * shipped in test/regressions.test.mjs -- they exercise the three C2 findings
 * (C-10 retention, C-11 determinism, C-12 prototype-safe names/ids) through a
 * different code path where possible (crafted applyOp/mergeState payloads
 * rather than the local mutator API), and add the boundary-matrix cases the
 * planner's acceptance bar calls out: 0, 1, N-1, N, N+1, empty, null,
 * undefined, NaN, -0, duplicate dispose, dispose-during-iteration, re-entrant
 * write, and an adversarial case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

const MAX_LAMPORT = 2 ** 53;

/* ===========================================================================
 * C-10: retention is O(live ids), not O(ops)
 * ======================================================================== */

test("C-10 boundary: 0 cycles -- a fresh OR-Set's _retention() is all zero", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const arr = d.array("s");
    assert.deepEqual(arr._retention(), { adds: 0, valueReg: 0, removed: 0 });
    d.dispose();
});

test("C-10 boundary: 1 cycle -- add then delete once leaves adds=0, valueReg=1", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const arr = d.array("s");
    arr.add({ id: "x", n: 0 });
    arr.deleteById("x");
    assert.deepEqual(arr._retention(), { adds: 0, valueReg: 1, removed: 1 });
    d.dispose();
});

test("C-10 boundary: N-1/N/N+1 live ids -- adds cardinality tracks live count exactly at each step", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const arr = d.array("s");
    // N-1 = 1, N = 2, N+1 = 3 live ids, added one at a time.
    arr.add({ id: "a" });
    assert.equal(arr._retention().adds, 1, "N-1: one live id");
    arr.add({ id: "b" });
    assert.equal(arr._retention().adds, 2, "N: two live ids");
    arr.add({ id: "c" });
    assert.equal(arr._retention().adds, 3, "N+1: three live ids");
    // Now delete them one at a time and confirm adds shrinks in step, never lagging.
    arr.deleteById("a");
    assert.equal(arr._retention().adds, 2, "deleting one of three drops adds by exactly one");
    arr.deleteById("b");
    assert.equal(arr._retention().adds, 1);
    arr.deleteById("c");
    assert.equal(arr._retention().adds, 0, "all live ids gone: adds must be empty, not carrying dead Maps");
    assert.equal(arr._retention().valueReg, 3, "all three value registers are retained regardless");
    d.dispose();
});

test("C-10: 10k add/delete cycles of the SAME id -- adds holds 0, valueReg holds 1 (O(live), not O(ops))", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const arr = d.array("s");
    const before = arr._retention();
    assert.deepEqual(before, { adds: 0, valueReg: 0, removed: 0 });
    for (let i = 0; i < 10000; i++) {
        arr.add({ id: "same", n: i });
        arr.deleteById("same");
    }
    const after = arr._retention();
    assert.equal(after.adds, 0, "adds retained a dead entry across 10k cycles: measured " + after.adds);
    assert.equal(after.valueReg, 1, "valueReg must hold exactly one register for the one distinct id: measured " + after.valueReg);
    // removed grows O(ops) by design (tombstone set; C4 seam), but confirm it at
    // least reflects every distinct tag emitted (10000 add tags, one per cycle).
    assert.equal(after.removed, 10000, "removed tombstone count should equal the number of distinct tags emitted");
    d.dispose();
});

test("C-10: interleaved multiple ids -- adds cardinality tracks ONLY live ids, never the op count", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const arr = d.array("s");
    const IDS = ["p", "q", "r", "s", "t"];
    let liveCount = 0;
    const live = new Set();
    for (let i = 0; i < 5000; i++) {
        const id = IDS[i % IDS.length];
        if (live.has(id)) {
            arr.deleteById(id);
            live.delete(id);
        } else {
            arr.add({ id, n: i });
            live.add(id);
        }
        // Assert at every step, not just at the end: adds must equal the live set
        // size right now, never drift toward the running op count.
        assert.equal(arr._retention().adds, live.size, "step " + i + ": adds diverged from the live id set");
    }
    d.dispose();
});

test("C-10: re-add after empty -- membership and value are both correct, and a genuinely later op still wins LWW", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const arr = d.array("s");
    arr.add({ id: "x", tag: "first" });
    arr.deleteById("x");
    assert.equal(arr._retention().adds, 0, "id must not be a live member right after delete");
    assert.equal(arr.hasId("x"), false);
    // Re-add after empty: a fresh local add(), not a merge.
    arr.add({ id: "x", tag: "second" });
    assert.equal(arr.hasId("x"), true, "re-add after empty must restore membership");
    assert.equal(arr.get("x").tag, "second", "re-add after empty must carry the new value");
    assert.equal(arr._retention().adds, 1, "exactly one live id after the re-add");
    assert.equal(arr._retention().valueReg, 1, "exactly one retained value register for the one distinct id");
    d.dispose();
});

test("C-10: a late lower-l op for a churned id LOSES the value race (retained valueReg), and two replicas that disagree on delivery of it still converge", () => {
    // Replica REF applies only the "clean" ops (never sees the late op).
    // Replica D applies the same clean ops AND the late, lower-l op.
    // Both must converge on the identical value for id "x": the retained
    // valueReg register is what makes this true -- if it had been dropped
    // (Option A, rejected in decisions/0002), the late lower-l op would win
    // locally on D and D would diverge from REF.
    const cleanOps = [
        { t: "add", c: "s", id: "x", n: 0, v: { tag: "first" }, l: 10, r: "A" },
        { t: "rm", c: "s", id: "x", g: ["A#0"], l: 11, r: "A" },
        { t: "add", c: "s", id: "x", n: 1, v: { tag: "second" }, l: 20, r: "A" }, // re-add, higher l
    ];
    // A late, out-of-order delivery: an "upd" for the same id with a LOWER l
    // than the current register (20). It must not move the value.
    const lateLowerOp = { t: "upd", c: "s", id: "x", v: { tag: "late-lower-should-lose" }, l: 5, r: "Z" };

    const ref = createCRDTDoc({ replicaId: "REF" });
    for (const op of cleanOps) ref.applyOp(op);
    const refVal = JSON.stringify(ref.array("s").get("x"));
    ref.dispose();

    const d = createCRDTDoc({ replicaId: "D" });
    for (const op of cleanOps) d.applyOp(op);
    d.applyOp(lateLowerOp);
    const dVal = JSON.stringify(d.array("s").get("x"));
    assert.equal(dVal, refVal, "a late lower-l op must not change the retained value: replicas diverged");
    assert.equal(d.array("s").get("x").tag, "second", "the late lower-l op's value must have LOST the LWW race");
    d.dispose();
});

test("C-10: a rejected (door-dropped) rm with a non-finite l must not trigger the retention prune", () => {
    // okOp validates BEFORE apply for every op except cinc/cdec: a rm with a
    // non-finite l must be dropped at the door, never reach the prune logic,
    // so the id's tag (and its adds entry) must be completely unaffected.
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const arr = d.array("s");
    arr.add({ id: "x" });
    assert.equal(arr._retention().adds, 1);
    d.applyOp({ t: "rm", c: "s", id: "x", g: ["R#0"], l: NaN, r: "R" });
    assert.equal(errs.length, 1, "a non-finite l on rm must be reported and dropped");
    assert.equal(arr._retention().adds, 1, "the rejected rm must not have pruned the live id's adds entry");
    assert.equal(arr.hasId("x"), true, "the rejected rm must not have removed membership");
    d.dispose();
});

test("C-10 duplicate dispose: disposing the doc twice does not throw, and the retention probe stays safely readable", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const arr = d.array("s");
    arr.add({ id: "x" });
    arr.deleteById("x");
    assert.doesNotThrow(() => d.dispose());
    assert.doesNotThrow(() => d.dispose(), "second dispose() must be idempotent, not throw");
    assert.doesNotThrow(() => arr._retention(), "the probe must remain callable on a disposed collection");
    assert.deepEqual(arr._retention(), { adds: 0, valueReg: 0, removed: 0 }, "dispose must have cleared the internal maps");
});

test("C-10 dispose-during-iteration: disposing the doc from inside an 'op' listener mid churn-loop does not throw and halts further mutation", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const arr = d.array("s");
    let disposedMidway = false;
    let opsAfterDispose = 0;
    d.on("op", (op) => {
        if (op.t === "rm" && !disposedMidway) {
            disposedMidway = true;
            d.dispose();
        } else if (disposedMidway) {
            opsAfterDispose++;
        }
    });
    assert.doesNotThrow(() => {
        for (let i = 0; i < 20; i++) {
            arr.add({ id: "id" + i });
            arr.deleteById("id" + i); // fires the "op" listener on the FIRST iteration's rm
        }
    });
    assert.equal(disposedMidway, true, "the listener must have actually fired mid-loop");
    // The doc-level dispatch (emit) no-ops once disposed, so no further 'op'
    // events are dispatched, even though the stale collection handle's local
    // add/delete calls themselves are not doc-disposed-gated. This is the
    // planner's asked-for boundary: dispose mid-iteration must not throw.
    assert.equal(opsAfterDispose, 0, "no further 'op' events should dispatch after doc.dispose()");
});

test("C-10 re-entrant write: adding a DIFFERENT id from inside the 'op' callback of an rm does not corrupt retention", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const arr = d.array("s");
    let reentered = false;
    d.on("op", (op) => {
        if (op.t === "rm" && !reentered) {
            reentered = true;
            arr.add({ id: "reentrant" }); // re-entrant local write from inside dispatch
        }
    });
    arr.add({ id: "x" });
    arr.deleteById("x"); // triggers the rm 'op' event synchronously, re-entering add()
    assert.equal(reentered, true, "the re-entrant add must actually have run");
    assert.equal(arr.hasId("reentrant"), true, "the re-entrant add's id must be a live member");
    assert.equal(arr.hasId("x"), false, "the original id must still be gone after the re-entrant write");
    const r = arr._retention();
    assert.equal(r.adds, 1, "only the re-entrant id should be live in adds: measured " + r.adds);
    assert.equal(r.valueReg, 2, "both distinct ids ever seen must have a retained value register: measured " + r.valueReg);
    d.dispose();
});

test("C-10 adversarial: numeric -0 and 0 as element ids stringify to the SAME OR-Set id ('0'), colliding by design of String() coercion -- no crash, no divergence, deterministic overwrite", () => {
    // Planner did not consider this: `identify` defaults to `v.id`, and the id is
    // then normalised with `String(id)`. String(-0) === String(0) === "0", so an
    // element {id: -0} and a later element {id: 0} silently collide onto ONE
    // OR-Set member, exactly like a JS Map or a JSON object would. This is not a
    // C2 regression (the id-normalisation predates C2) but it directly touches
    // the C-10 retention/C-11 determinism surface: two replicas that add -0 then
    // 0 (or vice versa) in different orders must still converge to the SAME
    // single member "0", not two.
    const a = createCRDTDoc({ replicaId: "A" });
    const arrA = a.array("s");
    arrA.add({ id: -0, tag: "neg-zero" });
    arrA.add({ id: 0, tag: "plain-zero" }); // collides onto the same id "0" -> becomes an "upd"
    assert.equal(arrA.size, 1, "adding -0 then 0 must collapse onto a single member, not two");
    assert.equal(arrA.hasId("0"), true);
    assert.equal(arrA.get("0").tag, "plain-zero", "the second add (0) must win as an in-place edit of the same id");
    assert.equal(arrA._retention().adds, 1, "only one live adds entry for the collided id");

    // Reverse order on a second replica, and converge via applyOp so we are
    // testing the crafted-remote path too, not just the local mutator.
    const b = createCRDTDoc({ replicaId: "B" });
    const opsA = [];
    const capture = createCRDTDoc({ replicaId: "A2" });
    capture.on("op", (op) => opsA.push(op));
    capture.array("s").add({ id: 0, tag: "plain-zero" });
    capture.array("s").add({ id: -0, tag: "neg-zero" }); // reverse order this time
    for (const op of opsA) b.applyOp(op);
    assert.equal(b.array("s").size, 1, "reverse order must also collapse onto one member");
    assert.equal(b.array("s").get("0").tag, "neg-zero", "later add (-0, stringified '0') wins as the in-place edit");
    a.dispose(); b.dispose(); capture.dispose();
});

/* ===========================================================================
 * C-11: snapshot()/getState() are byte-identical across replicas, no canon()
 * ======================================================================== */

test("C-11 boundary: empty doc -- snapshot() and getState().cols are both {} on a fresh doc, raw JSON.stringify", () => {
    const a = createCRDTDoc({ replicaId: "A" });
    const b = createCRDTDoc({ replicaId: "B" });
    assert.equal(JSON.stringify(a.snapshot()), "{}");
    assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()));
    assert.equal(JSON.stringify(a.getState().cols), JSON.stringify(b.getState().cols));
    a.dispose(); b.dispose();
});

test("C-11 boundary: a collection with one key (sort is a no-op) vs many keys (sort is active) both serialize deterministically", () => {
    // Explicit ops with FIXED l/r, applied via applyOp in opposite orders on the
    // two replicas: this isolates the serializer's key-order-independence from
    // any confound of two independently-ticking local clocks assigning
    // different lamports to the same key (which is a different, non-C-11,
    // effect and must not leak into this test).
    const a = createCRDTDoc({ replicaId: "R" });
    const b = createCRDTDoc({ replicaId: "R" });
    // one key: sort has nothing to do.
    const oneOp = { t: "set", c: "one", k: "solo", l: 1, r: "p", v: 1 };
    a.applyOp(oneOp);
    b.applyOp(oneOp);
    assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()), "single-key map: sort no-op must still match");
    // many keys, applied in opposite order on each replica: sort must be ACTIVE.
    const keys = ["zeta", "mid", "alpha", "kappa", "beta"];
    const manyOps = keys.map((k, i) => ({ t: "set", c: "many", k, l: i + 2, r: "p", v: k.length }));
    for (const op of manyOps) a.applyOp(op);
    for (const op of manyOps.slice().reverse()) b.applyOp(op);
    assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()), "many-key map learned in reverse order must still serialize identically");
    assert.equal(JSON.stringify(a.getState()), JSON.stringify(b.getState()));
    a.dispose(); b.dispose();
});

test("C-11: 3-collection doc (map + OR-Set + counter) replayed in FULLY reversed op AND id order converges to byte-identical snapshot()/getState()", () => {
    const ops = [
        { t: "set", c: "m", k: "k0", l: 1, r: "p", v: 0 },
        { t: "set", c: "m", k: "k1", l: 2, r: "p", v: 1 },
        { t: "set", c: "m", k: "k2", l: 3, r: "p", v: 2 },
        { t: "add", c: "arr", id: "i0", n: 0, v: { id: "i0", n: 0 }, l: 4, r: "p" },
        { t: "add", c: "arr", id: "i1", n: 1, v: { id: "i1", n: 1 }, l: 5, r: "p" },
        { t: "add", c: "arr", id: "i2", n: 2, v: { id: "i2", n: 2 }, l: 6, r: "p" },
        { t: "cinc", c: "votes", r: "p", p: 3 },
        { t: "cinc", c: "votes", r: "q", p: 7 },
        { t: "cdec", c: "votes", r: "p", n: 1 },
    ];
    const a = createCRDTDoc({ replicaId: "SAME" });
    const b = createCRDTDoc({ replicaId: "SAME" });
    for (const op of ops) a.applyOp(op);
    for (let i = ops.length - 1; i >= 0; i--) b.applyOp(ops[i]); // fully reversed: collections AND ids learned backwards
    assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()), "snapshot() diverged under reversed collection+id learn order");
    assert.equal(JSON.stringify(a.getState()), JSON.stringify(b.getState()), "getState() diverged under reversed collection+id learn order");
    a.dispose(); b.dispose();
});

/* ===========================================================================
 * C-12: __proto__ names/ids round-trip via Object.create(null), crafted-remote
 * ======================================================================== */

test("C-12 crafted-remote: __proto__ as an OR-Set element id via a raw applyOp payload (not the local API) round-trips and cannot pollute", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    // Simulate the wire: a hostile peer's applyOp frame naming a __proto__ id.
    d.applyOp({ t: "add", c: "arr", id: "__proto__", n: 0, v: { id: "__proto__", secret: 1 }, l: 1, r: "evil" });
    assert.equal(errs.length, 0, "a well-formed __proto__ id op must not be rejected by the door");
    assert.equal(d.array("arr").hasId("__proto__"), true, "the __proto__ id must be a live member");
    assert.equal(d.array("arr").get("__proto__").secret, 1);
    const state = d.getState();
    assert.ok(Object.hasOwn(state.cols.arr.adds, "__proto__"));
    assert.ok(Object.hasOwn(state.cols.arr.values, "__proto__"));
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
    d.dispose();
});

test("C-12 crafted-remote: __proto__ as a collection name via a JSON-transported mergeState payload round-trips intact", () => {
    // Build the state through the real API (own properties, per C-12), then
    // simulate the wire by round-tripping it through JSON -- this is the
    // realistic "hostile remote" shape: JSON.parse creates an OWN "__proto__"
    // property (verified: it does NOT reassign the parsed object's prototype),
    // so this is the correct way to model an attacker-controlled network frame.
    const src = createCRDTDoc({ replicaId: "SRC" });
    src.map("__proto__").set("k", "v");
    const wired = JSON.parse(JSON.stringify(src.getState()));
    assert.ok(Object.hasOwn(wired.cols, "__proto__"), "JSON round-trip must keep __proto__ as an own collection-name key");

    const dst = createCRDTDoc({ replicaId: "DST" });
    assert.doesNotThrow(() => dst.mergeState(wired));
    assert.equal(dst.map("__proto__").get("k"), "v", "the __proto__-named collection did not survive the crafted-remote mergeState");
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
    src.dispose(); dst.dispose();
});

test("C-12 crafted-remote: __proto__ as a counter replicaId via a raw applyOp payload round-trips without divergence or pollution", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    d.applyOp({ t: "cinc", c: "votes", r: "__proto__", p: 9 });
    assert.equal(errs.length, 0, "a well-formed __proto__ replicaId op must not be rejected");
    assert.equal(d.counter("votes").value(), 9);
    const state = d.getState();
    assert.ok(Object.hasOwn(state.cols.votes.p, "__proto__"));
    const d2 = createCRDTDoc({ replicaId: "R2" });
    d2.mergeState(state);
    assert.equal(d2.counter("votes").value(), 9, "the __proto__-replicaId cumulative did not round-trip through mergeState");
    assert.equal(({}).polluted, undefined);
    d.dispose(); d2.dispose();
});

test("C-12 adversarial: a mergeState payload using RAW OBJECT-LITERAL `{\"__proto__\": {...}}` (prototype reassignment, not an own key) is inert -- no throw, no pollution, entry silently unreachable rather than merged", () => {
    // This is a DIFFERENT craft than the JSON-transported case above. In actual
    // JS object-literal syntax (not JSON.parse), a quoted string key
    // "__proto__" is grammar-special-cased: it reassigns the object's own
    // [[Prototype]] instead of creating an own enumerable data property. So
    // `sadds["__proto__"]` on such a payload is never visited by the
    // `for...in` loops mergeState uses (they only see the object's actual own +
    // inherited-enumerable keys, and a reassigned-but-non-enumerable-accessor
    // prototype contributes nothing __proto__-named to enumerate). The
    // assertion the planner asked for -- "round-trips OR fails cleanly" -- must
    // hold for this craft too, just via the OTHER branch: fails cleanly.
    const hostileAdds = {};
    Object.setPrototypeOf(hostileAdds, { evil: { tag: 1 } }); // equivalent to the literal-syntax reassignment
    const payload = {
        replicaId: "SRC",
        clock: 5,
        cols: {
            arr: { kind: "set", adds: hostileAdds, removed: [], values: {} },
        },
    };
    const d = createCRDTDoc({ replicaId: "DST" });
    assert.doesNotThrow(() => d.mergeState(payload), "a hand-crafted prototype-reassignment payload must not throw out of mergeState");
    // The "__proto__" id itself must not have become a member (it was never
    // reachable as a for-in key), and the collection must be otherwise empty.
    assert.equal(d.array("arr").hasId("__proto__"), false);
    assert.equal(d.array("arr").size, 0, "no phantom member should have been created from the reassigned prototype");
    assert.equal(({}).polluted, undefined, "Object.prototype must not be polluted");
    assert.equal(Object.getPrototypeOf({}), Object.prototype, "a fresh object's prototype must be unaffected");
    d.dispose();
});

test("C-12 boundary: a __proto__ map KEY is guarded at apply() on BOTH the local and the crafted-remote path -- it never reaches getState/mergeState, by design (decision 0002)", () => {
    // Corrected from an earlier draft of this test, which wrongly assumed the
    // map axis was unguarded remotely. It is NOT: CRDT.js's map apply() has
    // `if (op.k === "__proto__") return false;` BEFORE the set/del branches, so
    // a crafted remote 'set'/'del' op naming k="__proto__" is silently a no-op
    // for EITHER op type -- no throw, no onError report (a false return from
    // apply() is not an error, just "did not change state"), and the key never
    // appears in getState()/mergeState(). Only the LOCAL .set()/.delete() throw
    // (an app author finds out immediately); the remote door fails closed
    // silently instead, so one crafted peer op cannot crash another replica.
    const src = createCRDTDoc({ replicaId: "SRC" });
    assert.throws(() => src.map("m").set("__proto__", 1), { name: "CRDTError" }, "the LOCAL set() path must still throw (decision 0002, unchanged)");
    assert.throws(() => src.map("m").delete("__proto__"), { name: "CRDTError" });

    const errs = [];
    const d = createCRDTDoc({ replicaId: "D", onError: (e) => errs.push(e) });
    d.applyOp({ t: "set", c: "m", k: "__proto__", l: 1, r: "peer", v: 42 });
    assert.equal(errs.length, 0, "a k='__proto__' remote op is a silent no-op, not an onError-reported rejection");
    // NOTE (out of C2 scope, flagged not asserted-against): map.get("__proto__")
    // does NOT reliably return undefined here -- it reads through a plain-object
    // read-only projection (`proj["__proto__"]`), which returns the INHERITED
    // Object.prototype via the object's own __proto__ accessor regardless of
    // whether the key was ever set as an own property. That is a pre-existing
    // quirk of the read-side projection (untouched by the C2 diff: `store()`,
    // `get()`, `has()` are unchanged), not a C-12 regression -- C-12 only
    // covers getState()/mergeState() serialization, which IS an own-key-safe
    // path (Object.create(null) + apply()'s guard), asserted below via `size`
    // and `entries`, not via the read-through `get()`/`has()` accessors.
    assert.equal(d.map("m").size, 0, "the map must remain empty: no key was ever stored (Object.keys sees only OWN keys)");
    const state = d.getState();
    assert.equal(Object.hasOwn(state.cols.m.entries, "__proto__"), false, "getState() must not emit a key that was never applied");

    // mergeState path: same guard, same result -- the entry cannot round-trip
    // because it was never accepted into `entries` in the first place. Built
    // with a COMPUTED key (an own property, the realistic JSON-wire shape --
    // see the "quoted string literal vs computed key" adversarial test above)
    // so mergeState's `for...in` actually visits "__proto__" and exercises the
    // map's own apply() guard, rather than silently never enumerating it.
    const proto = "__proto__";
    const hostileState = { replicaId: "X", clock: 1, cols: { m: { kind: "map", entries: { [proto]: [1, "peer", 0, 42] } } } };
    assert.ok(Object.hasOwn(hostileState.cols.m.entries, "__proto__"), "sanity: the crafted payload must carry __proto__ as an own key");
    const d2 = createCRDTDoc({ replicaId: "D2" });
    assert.doesNotThrow(() => d2.mergeState(hostileState));
    assert.equal(d2.map("m").size, 0, "mergeState must not have accepted a __proto__-keyed entry into the map");
    assert.equal(Object.hasOwn(d2.getState().cols.m.entries, "__proto__"), false, "the entry must not round-trip out through getState() either");
    assert.equal(d2.map("m").size, 0);
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
    src.dispose(); d.dispose(); d2.dispose();
});

/* ===========================================================================
 * Cross-cutting: null / undefined / NaN entry-point boundaries
 * ======================================================================== */

test("boundary: op.id === null or undefined is dropped at the door for add/upd/rm, never reaches the retention prune", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    d.applyOp({ t: "add", c: "arr", id: null, n: 0, v: 1, l: 1, r: "p" });
    d.applyOp({ t: "add", c: "arr", id: undefined, n: 0, v: 1, l: 2, r: "p" });
    d.applyOp({ t: "rm", c: "arr", id: null, g: [], l: 3, r: "p" });
    assert.equal(errs.length, 3, "all three malformed-id ops must be dropped and reported");
    assert.equal(d.array("arr").size, 0, "no phantom member from a null/undefined id");
    d.dispose();
});

test("boundary: element value v === null / undefined is a legal OR-Set payload (only the id, not the value, is validated)", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const arr = d.array("arr");
    d.applyOp({ t: "add", c: "arr", id: "x", n: 0, v: null, l: 1, r: "p" });
    assert.equal(arr.get("x"), null);
    d.applyOp({ t: "upd", c: "arr", id: "x", v: undefined, l: 2, r: "p" });
    assert.equal(arr.get("x"), undefined);
    assert.equal(arr.hasId("x"), true, "membership must be unaffected by a null/undefined value");
    d.dispose();
});

test("boundary: NaN as a Lamport l on add/upd/rm is rejected at the door for every OR-Set op type", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    d.applyOp({ t: "add", c: "arr", id: "x", n: 0, v: 1, l: NaN, r: "p" });
    d.applyOp({ t: "upd", c: "arr", id: "x", v: 1, l: NaN, r: "p" });
    d.applyOp({ t: "rm", c: "arr", id: "x", g: [], l: NaN, r: "p" });
    assert.equal(errs.length, 3);
    assert.equal(d.array("arr").size, 0);
    d.dispose();
});

test("boundary: -0 as a counter cumulative (p) passes the door (finite, non-negative) but is a real no-op against a cur=0 baseline -- a later genuine increment still works", () => {
    // Object.is(-0, 0) is false but -0 >= 0 is true and Number.isFinite(-0) is
    // true, so okOp ACCEPTS it (confirmed: no onError). But cinc's apply() is
    // `if (op.p > cur) P.set(...)`, and `cur` defaults to 0 for a replica never
    // seen before, so `-0 > 0` is false: the write does not happen, and P gets
    // NO entry for that replica (not an entry holding -0/0 -- no entry at all).
    // This is correct: a "cumulative of zero" carries no information a missing
    // entry doesn't already encode, so it must not be mistaken for a rejected
    // op. Confirm the door accepted it, the value stays 0, no P entry was
    // created, and the replica is NOT stuck -- a subsequent genuine cinc from
    // the same replicaId still applies normally.
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    d.applyOp({ t: "cinc", c: "c", r: "p", p: -0 });
    assert.equal(errs.length, 0, "-0 must pass the door, not be rejected");
    assert.equal(d.counter("c").value(), 0);
    const state = d.getState();
    assert.equal(Object.hasOwn(state.cols.c.p, "p"), false, "a cumulative of -0 against a 0 baseline must not create a P entry");
    // Not stuck: a real increment from the SAME replicaId afterward still applies.
    d.applyOp({ t: "cinc", c: "c", r: "p", p: 5 });
    assert.equal(errs.length, 0);
    assert.equal(d.counter("c").value(), 5, "a genuine later cinc from the same replicaId must still apply after a -0 no-op");
    d.dispose();
});
