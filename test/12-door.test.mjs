/**
 * QA session C1 gap-fill: boundary matrix + assertions the planner's five
 * claims did not yet have a directly-runnable node:test proof for.
 *
 * Door policy: reject-and-continue (decisions/0001-remote-op-door.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

const MAX_LAMPORT = 2 ** 53;

/* -- l boundary: N-1 accepted, N rejected (matches tick()'s ceiling) -------- */

test("door: l = 2^53-1 is accepted (a legit high remote lamport is still receivable)", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errs.push(e) });
    d.applyOp({ t: "set", c: "m", k: "x", l: MAX_LAMPORT - 1, r: "peer", v: "ok" });
    assert.equal(errs.length, 0, "a finite l just under the ceiling must not be rejected");
    assert.equal(d.map("m").get("x"), "ok", "the accepted op must actually apply");
    d.dispose();
});

test("door: l = 2^53 is rejected (at the ceiling, not just above it)", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errs.push(e) });
    d.applyOp({ t: "set", c: "m", k: "x", l: MAX_LAMPORT, r: "peer", v: "poison" });
    assert.equal(errs.length, 1, "l at the ceiling must be dropped and reported");
    assert.equal(d.map("m").get("x"), undefined, "a rejected op must not have applied");
    d.dispose();
});

/* -- counter p/n: negative-finite reject, non-number reject, valid applies -- */

test("door: a negative-but-finite counter p is rejected (decision 0001: p/n must be non-negative)", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errs.push(e) });
    d.counter("c").inc(5);
    d.applyOp({ t: "cinc", c: "c", r: "peer", p: -5 }); // finite, but negative
    assert.equal(errs.length, 1, "a negative-finite p must be dropped and reported");
    assert.equal(d.counter("c").peek(), 5, "the negative-finite op must not have moved the counter");
    d.dispose();
});

test("door: a negative-but-finite counter n is rejected", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errs.push(e) });
    d.applyOp({ t: "cdec", c: "c", r: "peer", n: -1 });
    assert.equal(errs.length, 1, "a negative-finite n must be dropped and reported");
    assert.equal(d.counter("c").peek(), 0);
    d.dispose();
});

test("door: a non-number counter p/n is rejected, and a subsequent valid counter op still applies", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errs.push(e) });
    for (const bad of ["9", null, undefined, {}, true, [1]]) {
        d.applyOp({ t: "cinc", c: "c", r: "peer", p: bad });
    }
    assert.equal(errs.length, 6, "every non-number p must be dropped and reported");
    assert.equal(d.counter("c").peek(), 0, "no non-number op may have moved the counter");
    // a valid remote counter op still applies after a run of rejects
    d.applyOp({ t: "cinc", c: "c", r: "peer", p: 7 });
    assert.equal(d.counter("c").peek(), 7, "a well-formed counter op after rejects was dropped too");
    d.dispose();
});

test("door: -0 is a legal (non-negative, finite) counter p and applies as 0", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errs.push(e) });
    d.applyOp({ t: "cinc", c: "c", r: "peer", p: -0 });
    assert.equal(errs.length, 0, "-0 satisfies p >= 0 and must not be rejected");
    assert.equal(d.counter("c").peek(), 0);
    d.dispose();
});

/* -- mergeState kind-mismatch: rejected+reported, no corruption, no throw -- */

test("door: mergeState with a kind-mismatched collection (map arrives as set) is rejected, reported, and does not corrupt the existing map", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errs.push(e) });
    d.map("x").set("a", 1); // 'x' is a MAP locally
    const before = JSON.stringify(d.map("x").snapshot());
    assert.doesNotThrow(() => d.mergeState({
        cols: { x: { kind: "set", adds: { z: { "peer#0": 1 } }, removed: [], values: { z: [1, "peer", 9] } } },
    }));
    assert.equal(errs.length, 1, "the kind-mismatched collection must be reported to onError");
    assert.equal(JSON.stringify(d.map("x").snapshot()), before, "the existing map must be untouched by a kind-mismatched merge");
    assert.throws(() => d.array("x"), (e) => e && e.code === "kind_mismatch", "the collection must still be a map, not silently reclassified");
    d.dispose();
});

test("door: mergeState with a kind-mismatched collection (set arrives as map) is rejected, reported, and does not corrupt the existing set", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errs.push(e) });
    d.array("y").add({ id: "a", v: 1 }); // 'y' is a SET locally
    const before = JSON.stringify(d.array("y").snapshot());
    assert.doesNotThrow(() => d.mergeState({
        cols: { y: { kind: "map", entries: { k: [1, "peer", 0, "v"] } } },
    }));
    assert.equal(errs.length, 1, "the kind-mismatched collection must be reported to onError");
    assert.equal(JSON.stringify(d.array("y").snapshot()), before, "the existing set must be untouched by a kind-mismatched merge");
    d.dispose();
});

test("door: a valid mergeState still converges after a kind-mismatch was rejected", () => {
    const errs = [];
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B", onError: (e) => errs.push(e) });
    A.map("m").set("k", "v");
    B.map("m").set("other", 1);
    // Reject a bogus kind-mismatch on an unrelated name, then merge for real.
    B.mergeState({ cols: { m: { kind: "set", adds: {}, removed: [], values: {} } } }); // 'm' is a map on B -> mismatch, rejected
    B.mergeState(A.getState());
    assert.equal(B.map("m").get("k"), "v", "a valid mergeState must still converge after an earlier rejected kind-mismatch");
    assert.ok(errs.length >= 1);
    A.dispose(); B.dispose();
});

/* -- rm with an empty tag-set: a legal zero-element removal, not malformed -- */

test("door: rm with g=[] is a legal (no-op) removal, not rejected", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errs.push(e) });
    d.array("a").add({ id: "x", v: 1 });
    assert.doesNotThrow(() => d.applyOp({ t: "rm", c: "a", id: "x", g: [], l: 5, r: "peer" }));
    assert.equal(errs.length, 0, "an empty removal set must not be treated as malformed");
    d.dispose();
});

/* -- duplicate dispose / re-entrancy through the door ----------------------- */

test("door: applyOp after dispose is inert, and dispose remains idempotent", () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    d.map("m").set("a", 1);
    d.dispose();
    assert.doesNotThrow(() => d.applyOp({ t: "set", c: "m", k: "b", l: 1, r: "peer", v: 2 }));
    assert.doesNotThrow(() => d.dispose());
    assert.doesNotThrow(() => d.dispose());
});

test("door: disposing the doc from inside onError mid-applyOps does not throw and the batch loop still terminates", () => {
    const d = createCRDTDoc({ replicaId: "r1" });
    d.onErrorFired = 0;
    let disposedFromCallback = false;
    const doc = createCRDTDoc({
        replicaId: "r2",
        onError: () => { if (!disposedFromCallback) { disposedFromCallback = true; doc.dispose(); } },
    });
    assert.doesNotThrow(() => doc.applyOps([
        { t: "bogus", c: "m" },                                   // triggers onError -> disposes mid-batch
        { t: "set", c: "m", k: "b", l: 1, r: "peer", v: 2 },      // must not throw against a disposed doc
        { t: "cinc", c: "c", r: "peer", p: "not-a-number" },       // ditto
    ]));
    assert.equal(disposedFromCallback, true);
});

test("door: a re-entrant applyOp from inside onError still applies correctly", () => {
    // A single applyOp is STRICT (an unknown op type throws synchronously), so
    // to reach onError re-entrantly we go through applyOps (RESILIENT: it
    // catches the throw and reports it) -- the transport-safe path this
    // scenario is actually reachable from.
    const applied = [];
    const d = createCRDTDoc({
        replicaId: "r1",
        onError: () => {
            // re-entrant write triggered from within the error hook
            d.applyOp({ t: "set", c: "m", k: "reentrant", l: 1, r: "peer", v: 42 });
            applied.push(true);
        },
    });
    d.applyOps([{ t: "bogus", c: "m" }]); // triggers the onError above
    assert.equal(applied.length, 1);
    assert.equal(d.map("m").get("reentrant"), 42, "the re-entrant write from onError must have applied");
    d.dispose();
});

/* -- adversarial: boxed primitives must not fool typeof-based validation --- */

test("door: a boxed Number/String for l/r is rejected (typeof guards against valueOf-coercible objects)", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "r1", onError: (e) => errs.push(e) });
    // eslint-disable-next-line no-new-wrappers
    d.applyOp({ t: "set", c: "m", k: "x", l: new Number(5), r: "peer", v: 1 });
    // eslint-disable-next-line no-new-wrappers
    d.applyOp({ t: "set", c: "m", k: "x", l: 5, r: new String("peer"), v: 1 });
    assert.equal(errs.length, 2, "boxed primitives must not satisfy typeof === 'number'/'string'");
    assert.equal(d.map("m").get("x"), undefined);
    d.dispose();
});

/* -- 10k good ops + all 7 poison kinds + 10k good ops: byte-identical -------- */

function poisonBattery() {
    return [
        { t: "set", c: "M", k: "z", l: Infinity, r: "evil", v: 1 },          // C-01
        { t: "set", c: "M", k: "z", l: NaN, r: "evil", v: 1 },               // C-02
        { t: "cinc", c: "C", r: "evil", p: "999" },                          // C-03
        { t: "set", c: "M", k: "z", r: "evil", v: 1 },                       // C-04 (missing l)
        { t: "add", c: "M", id: "1", n: 0, v: {}, l: 5, r: "evil" },         // C-05 (kind-mismatch)
        // C-06 exercised via mergeState below, not an op
        { t: "set", c: "M", k: "z", l: 2 ** 53, r: "evil", v: 1 },           // C-07
    ];
}

function driveGood(d, n, offset) {
    for (let i = 0; i < n; i++) {
        const k = "k" + ((i + offset) % 37);
        d.map("M").set(k, i);
        if (i % 5 === 0) d.array("A").add({ id: k, v: i });
        if (i % 7 === 0) d.counter("C").inc(1);
    }
}

test("10k good ops + all 7 poison kinds + 10k good ops == byte-identical canonical snapshot to a poison-free run", () => {
    const canon = (doc) => {
        const s = doc.snapshot();
        const out = {};
        for (const k of Object.keys(s).sort()) out[k] = s[k];
        return JSON.stringify(out);
    };

    const clean = createCRDTDoc({ replicaId: "R" });
    driveGood(clean, 10000, 0);
    driveGood(clean, 10000, 10000);
    const target = canon(clean);
    clean.dispose();

    const errs = [];
    const dirty = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    driveGood(dirty, 10000, 0);
    for (const op of poisonBattery()) dirty.applyOp(op);
    assert.doesNotThrow(() => dirty.mergeState({ cols: { A: { kind: "set", adds: {}, values: {} } } })); // C-06: missing `removed`
    driveGood(dirty, 10000, 10000);
    assert.ok(errs.length >= poisonBattery().length, "every poison op must have been reported");
    assert.equal(canon(dirty), target, "a poison attempt in the middle of 20k good ops changed the converged state");
    dirty.dispose();
});
