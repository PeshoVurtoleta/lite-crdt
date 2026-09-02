// C5.2 QA gap-fill: boundary matrix + adversarial cases for the RGA list delete
// surface that test/21-list-delete.test.mjs does not already cover -- the full
// delete(index)/deleteById(bl,br) boundary matrix (0, 1, N-1, N, N+1, empty,
// null, undefined, NaN, -0), the ldel door's own fail-closed matrix (mirroring
// the lins door matrix in test/20-list-door.test.mjs), the concurrent-delete
// remover-stamp convergence measured in BOTH stamp orderings, a multi-hop
// anchor-survives chain whose origin is itself born-dead, the reviewer's noted
// phantom-anchor case (negative/zero bl/ol never touching a real element), an
// unanticipated Map(-0/+0) key-collision case, duplicate dispose, dispose-
// during-iteration and a re-entrant write, all scoped to lins+ldel only (no
// move/serialization/compaction).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

const MAX_LAMPORT = 2 ** 53;

function capture(doc, sink) { doc.on("op", (op) => sink.push(op)); }

function makePrng(seed) {
    let x = seed >>> 0 || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}
function shuffle(arr, rng) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = rng() % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        for (const p of permutations(rest)) out.push([arr[i]].concat(p));
    }
    return out;
}

/* === A. delete(index) full boundary matrix: 0, 1, N-1, N, N+1, empty, ===== */
/* === null, undefined, NaN, -0 ============================================ */

test("delete(index) boundary matrix on N=5: 0/1/N-1 valid, N/N+1/-1/frac/NaN/Inf/null/undef invalid, -0 === 0", () => {
    function fresh() {
        const doc = createCRDTDoc({ replicaId: "A" });
        const l = doc.list("seq");
        for (let i = 0; i < 5; i++) l.insert(i, "e" + i);
        return { doc, l };
    }
    const isMis = (e) => e && e.code === "misconfigured";

    // 0 (first element)
    { const { doc, l } = fresh(); assert.equal(l.delete(0), true); assert.deepEqual(l.values(), ["e1", "e2", "e3", "e4"]); doc.dispose(); }
    // 1 (middle)
    { const { doc, l } = fresh(); assert.equal(l.delete(1), true); assert.deepEqual(l.values(), ["e0", "e2", "e3", "e4"]); doc.dispose(); }
    // N-1 = 4 (last)
    { const { doc, l } = fresh(); assert.equal(l.delete(4), true); assert.deepEqual(l.values(), ["e0", "e1", "e2", "e3"]); doc.dispose(); }
    // N = 5 (one past the last live element): invalid
    { const { doc, l } = fresh(); assert.throws(() => l.delete(5), isMis, "index === size must throw"); assert.equal(l.size, 5); doc.dispose(); }
    // N+1 = 6: invalid
    { const { doc, l } = fresh(); assert.throws(() => l.delete(6), isMis); assert.equal(l.size, 5); doc.dispose(); }
    // -1: invalid
    { const { doc, l } = fresh(); assert.throws(() => l.delete(-1), isMis); assert.equal(l.size, 5); doc.dispose(); }
    // fractional: invalid
    { const { doc, l } = fresh(); assert.throws(() => l.delete(2.5), isMis); assert.equal(l.size, 5); doc.dispose(); }
    // NaN / Infinity / -Infinity / null / undefined: invalid
    { const { doc, l } = fresh();
        for (const bad of [NaN, Infinity, -Infinity, null, undefined]) {
            assert.throws(() => l.delete(bad), isMis, "delete(" + String(bad) + ") must throw");
        }
        assert.equal(l.size, 5);
        doc.dispose();
    }
    // empty list: delete(0) throws (index >= size, size === 0)
    { const doc = createCRDTDoc({ replicaId: "A" }); const l = doc.list("seq");
        assert.throws(() => l.delete(0), isMis, "delete(0) on an empty list must throw");
        doc.dispose();
    }
    // -0 is Number.isInteger(-0) === true and behaves EXACTLY like index 0
    { const { doc, l } = fresh(); assert.equal(l.delete(-0), true); assert.deepEqual(l.values(), ["e1", "e2", "e3", "e4"]); doc.dispose(); }
});

/* === B. deleteById(bl, br) with adversarial bl/br types (LOCAL API, no ===== */
/* === door validation) -- must fail closed to `false`, never throw, ======= */
/* === never touch the real element, never resurrect/pollute prototypes ==== */

test("deleteById(bl, br) with adversarial non-matching types is a harmless false, never touches the real element", () => {
    const doc = createCRDTDoc({ replicaId: "R" });
    const l = doc.list("seq");
    const id = l.insert(0, "x"); // "R#1"
    assert.equal(id, "R#1");

    const emitted = [];
    capture(doc, emitted);

    // bl adversarial: NaN, negative, -0-adjacent-but-wrong-writer, string, null,
    // undefined, object, array, boolean -- paired with the REAL writer "R" so
    // only bl differs from the real birth.
    for (const badBl of [NaN, -1, "1", null, undefined, {}, [], true, Symbol("x")]) {
        assert.doesNotThrow(() => l.deleteById(badBl, "R"), "deleteById must never throw on bl=" + String(badBl));
        assert.equal(l.deleteById(badBl, "R"), false, "deleteById(" + String(badBl) + ", 'R') must be a no-op");
    }
    // br adversarial: null, undefined, number, object, array, boolean, empty
    // string, and prototype-poison strings -- paired with the REAL lamport 1 so
    // only br differs from the real birth.
    for (const badBr of [null, undefined, 1, {}, [], true, "", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
        assert.doesNotThrow(() => l.deleteById(1, badBr), "deleteById must never throw on br=" + String(badBr));
        assert.equal(l.deleteById(1, badBr), false, "deleteById(1, " + String(badBr) + ") must be a no-op");
    }
    assert.equal(emitted.length, 0, "every mismatched-type no-op must emit nothing");
    assert.deepEqual(l.values(), ["x"], "the real element must survive every adversarial mismatched deleteById");
    assert.equal(({}).polluted, undefined, "no prototype pollution from a prototype-name br probe");

    // The genuine call still works afterward.
    assert.equal(l.deleteById(1, "R"), true);
    assert.deepEqual(l.values(), []);
    assert.equal(emitted.length, 1);
    doc.dispose();
});

/* === C. The ldel door's own fail-closed matrix (mirrors the lins matrix in */
/* === test/20-list-door.test.mjs) ========================================= */

function feedRemoteLdel(fields, seedInsert = true) {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const l = d.list("seq");
    if (seedInsert) l.insert(0, "seed"); // birth anchor (l=1, r="R")
    const op = Object.assign({ t: "ldel", c: "seq", l: 9, r: "peer", bl: 1, br: "R" }, fields);
    d.applyOp(op);
    return { d, l, errs };
}

test("door: ldel's OWN l/r boundary (the delete's stamp, not the target) -- fail-closed matrix, seed untouched on rejection", () => {
    for (const badL of [NaN, Infinity, -Infinity, MAX_LAMPORT, MAX_LAMPORT + 1, "5", null, undefined]) {
        const { d, l, errs } = feedRemoteLdel({ l: badL });
        assert.equal(errs.length, 1, "ldel l=" + String(badL) + " must be rejected");
        assert.deepEqual(l.values(), ["seed"], "a door-rejected ldel must not touch the seed element");
        d.dispose();
    }
    // l boundary edges that MUST be accepted (and do delete the seed, since bl/br target it).
    { const { d, l, errs } = feedRemoteLdel({ l: MAX_LAMPORT - 1 }); assert.equal(errs.length, 0); assert.deepEqual(l.values(), []); d.dispose(); }
    { const { d, l, errs } = feedRemoteLdel({ l: -0 }); assert.equal(errs.length, 0, "-0 is finite and must be accepted for the delete's own stamp"); assert.deepEqual(l.values(), []); d.dispose(); }

    for (const badR of ["", null, undefined, 5, {}]) {
        const { d, l, errs } = feedRemoteLdel({ r: badR });
        assert.equal(errs.length, 1, "ldel r=" + String(badR) + " must be rejected");
        assert.deepEqual(l.values(), ["seed"]);
        d.dispose();
    }
});

test("door: ldel bl/br (the TARGET birth anchor) -- fail-closed matrix; bl=0/-1 and br='__proto__' are door-VALID placeholders, not rejections", () => {
    for (const badBl of [NaN, Infinity, -Infinity, MAX_LAMPORT, MAX_LAMPORT + 1, "1", null, undefined, {}]) {
        const { d, l, errs } = feedRemoteLdel({ bl: badBl });
        assert.equal(errs.length, 1, "ldel bl=" + String(badBl) + " must be rejected");
        assert.deepEqual(l.values(), ["seed"], "a door-rejected ldel must not touch the seed");
        assert.equal(l._retention().pending, 0, "a door-rejected ldel must never reach the placeholder buffer");
        d.dispose();
    }
    for (const badBr of ["", null, undefined, 5, {}, []]) {
        const { d, l, errs } = feedRemoteLdel({ br: badBr });
        assert.equal(errs.length, 1, "ldel br=" + String(badBr) + " must be rejected");
        assert.deepEqual(l.values(), ["seed"]);
        assert.equal(l._retention().pending, 0);
        d.dispose();
    }
    // Door-VALID but fictional targets: harmless placeholders, no error, seed untouched.
    { const { d, l, errs } = feedRemoteLdel({ bl: 0, br: "ghost" }); assert.equal(errs.length, 0); assert.deepEqual(l.values(), ["seed"]); assert.equal(l._retention().pending, 1); d.dispose(); }
    { const { d, l, errs } = feedRemoteLdel({ bl: -1, br: "ghost" }); assert.equal(errs.length, 0); assert.deepEqual(l.values(), ["seed"]); assert.equal(l._retention().pending, 1); d.dispose(); }
    { const { d, l, errs } = feedRemoteLdel({ bl: MAX_LAMPORT - 1, br: "ghost" }); assert.equal(errs.length, 0); assert.deepEqual(l.values(), ["seed"]); assert.equal(l._retention().pending, 1); d.dispose(); }
    { const { d, l, errs } = feedRemoteLdel({ bl: 1, br: "__proto__" }); assert.equal(errs.length, 0, "'__proto__' is a syntactically legal string id"); assert.deepEqual(l.values(), ["seed"]); assert.equal(l._retention().pending, 1); assert.equal(({}).polluted, undefined); d.dispose(); }
});

/* === D. Concurrent-delete remover-stamp convergence, BOTH stamp orderings */
/* === (measured via the only observable consequence in C5.2: converged ==== */
/* === values/ids/size and the monotone del, since (dl,dr) is not on the ==== */
/* === public surface yet -- getState/_retention ship no such probe until === */
/* === C5.4) ================================================================ */

test("concurrent delete of ONE element converges identically regardless of arrival order, for BOTH possible winning stamps", () => {
    function converge(del1, del2, insertOp) {
        // Deliver in both possible arrival orders on two independent replicas.
        const R1 = createCRDTDoc({ replicaId: "R1" });
        const R2 = createCRDTDoc({ replicaId: "R2" });
        R1.applyOp(insertOp); R2.applyOp(insertOp);
        R1.applyOp(del1); R1.applyOp(del2);
        R2.applyOp(del2); R2.applyOp(del1);
        const snap1 = JSON.stringify(R1.snapshot());
        const snap2 = JSON.stringify(R2.snapshot());
        assert.equal(snap1, snap2, "converged snapshot diverged by delete-arrival order");
        assert.deepEqual(R1.list("seq").values(), []);
        assert.deepEqual(R2.list("seq").values(), []);
        assert.equal(R1.list("seq").size, 0);
        assert.equal(R2.list("seq").size, 0);
        // Redelivering EITHER stamp again, in any order, on either replica is a
        // pure no-op -- del is monotone and never flips back regardless of which
        // stamp is "stored" (unobservable) as the winner.
        R1.applyOp(del1); R1.applyOp(del2); R1.applyOp(del1); R1.applyOp(del2);
        R2.applyOp(del1); R2.applyOp(del2);
        assert.deepEqual(R1.list("seq").values(), []);
        assert.deepEqual(R2.list("seq").values(), []);
        assert.equal(JSON.stringify(R1.snapshot()), JSON.stringify(R2.snapshot()));
        R1.dispose(); R2.dispose();
    }

    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "x"); // A#1
    A.dispose();
    const insertOp = log[0];

    // Ordering 1: del2 (l=7,"R2") has the HIGHER (lamport, replicaId) stamp.
    converge(
        { t: "ldel", c: "seq", l: 5, r: "R1", bl: 1, br: "A" },
        { t: "ldel", c: "seq", l: 7, r: "R2", bl: 1, br: "A" },
        insertOp,
    );
    // Ordering 2 (FLIPPED): del1 (l=9,"R1") now has the HIGHER stamp -- the
    // planner's own suite only ever exercised the first ordering; a comparator
    // bug that silently favored "whichever arrived first" rather than tsWins
    // would only show up here.
    converge(
        { t: "ldel", c: "seq", l: 9, r: "R1", bl: 1, br: "A" },
        { t: "ldel", c: "seq", l: 3, r: "R2", bl: 1, br: "A" },
        insertOp,
    );
    // Ordering 3: equal lamport, tie-broken by replicaId ("Z2" > "Z1").
    converge(
        { t: "ldel", c: "seq", l: 5, r: "Z1", bl: 1, br: "A" },
        { t: "ldel", c: "seq", l: 5, r: "Z2", bl: 1, br: "A" },
        insertOp,
    );
});

/* === E. Multi-hop anchor-survives chain whose OWN origin is born-dead ==== */

test("anchor-survives, multi-hop: an insert chain whose first-hop origin is itself born-dead converges identically under every delivery order", () => {
    // x0 is born by A, then deleted by A. b1 (by B) names x0 as origin. c1 (by C)
    // names b1 as origin. Every permutation of [a0-insert, a0-delete, b1, c1]
    // must converge to the SAME state: x0 gone, b1 and c1 present and correctly
    // ordered -- including permutations where the delete arrives before x0 is
    // even born (the true born-dead / multi-hop-origin case).
    const A = createCRDTDoc({ replicaId: "A" });
    const logA = [];
    capture(A, logA);
    A.list("seq").insert(0, "x0"); // A#1
    A.list("seq").delete(0);      // deletes x0
    A.dispose();
    const [a0, delA0] = logA;
    assert.equal(a0.t, "lins"); assert.equal(delA0.t, "ldel");

    // B derives b1's stamp/origin by causally applying a0 first (warm-up only;
    // the warm-up doc is discarded -- only the resulting op ships).
    const B = createCRDTDoc({ replicaId: "B" });
    const logB = [];
    capture(B, logB);
    B.applyOp(a0);
    B.list("seq").insert(1, "b1"); // origin = (A, 1)
    B.dispose();
    const b1 = logB[0];
    assert.equal(b1.or, "A"); assert.equal(b1.ol, 1);

    // C derives c1's stamp/origin by causally applying a0 then b1.
    const C = createCRDTDoc({ replicaId: "C" });
    const logC = [];
    capture(C, logC);
    C.applyOp(a0); C.applyOp(b1);
    C.list("seq").insert(2, "c1"); // origin = (B, b1.l)
    C.dispose();
    const c1 = logC[0];
    assert.equal(c1.or, "B"); assert.equal(c1.ol, b1.l);

    let ref = null;
    for (const perm of permutations([a0, delA0, b1, c1])) {
        const d = createCRDTDoc({ replicaId: "Z" });
        d.applyOps(perm);
        const l = d.list("seq");
        assert.deepEqual(l.values(), ["b1", "c1"], "x0 must be deleted and b1/c1 correctly chained for permutation " + JSON.stringify(perm.map((o) => o.t + ":" + o.r)));
        assert.deepEqual(l.ids(), ["B#" + b1.l, "C#" + c1.l]);
        assert.doesNotThrow(() => l._validate(d.clock()), "structural invariant broke for a multi-hop born-dead-origin permutation");
        const snap = JSON.stringify(d.snapshot());
        if (ref === null) ref = snap;
        else assert.equal(snap, ref, "multi-hop anchor-survives ordering diverged across a permutation");
        d.dispose();
    }
});

/* === F. Phantom-anchor: negative/zero bl/ol never crash, never touch a === */
/* === real element, doc stays valid ======================================= */

test("phantom-anchor: crafted lins/ldel with negative or zero bl/ol never crash, never touch the real element, doc stays valid", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "P", onError: (e) => errs.push(e) });
    const l = d.list("seq");
    l.insert(0, "real"); // birth (l=1, r="P")
    const before = l._retention().pending;

    const phantoms = [
        { t: "ldel", c: "seq", l: 100, r: "att", bl: 0, br: "ghost" },
        { t: "ldel", c: "seq", l: 101, r: "att", bl: -1, br: "ghost" },
        { t: "ldel", c: "seq", l: 102, r: "att", bl: -0, br: "ghost2" },
        { t: "lins", c: "seq", l: 103, r: "att", or: "ghost", ol: 0, v: "phantom" },
        { t: "lins", c: "seq", l: 104, r: "att", or: "ghost", ol: -1, v: "phantom" },
    ];
    for (const op of phantoms) {
        assert.doesNotThrow(() => d.applyOp(op), "a phantom-anchor frame must never throw: " + JSON.stringify(op));
        assert.deepEqual(l.values(), ["real"], "a phantom-anchor frame must never touch the real element");
        assert.doesNotThrow(() => l._validate(d.clock()), "doc must stay structurally valid after a phantom-anchor frame");
    }
    // Each phantom frame targets a genuinely distinct never-arriving anchor, so
    // each consumes exactly one placeholder slot -- bounded, not unbounded.
    assert.equal(l._retention().pending, before + phantoms.length, "phantom-anchor frames must be bounded (one slot each), not runaway");
    assert.equal(errs.length, 0, "a door-valid phantom-anchor frame is not an onError rejection, only a harmless placeholder/pend");
    d.dispose();
});

/* === G. Adversarial, unanticipated: Map SameValueZero unifies -0 and +0 == */
/* === as a birth-anchor key -- bl=-0 legitimately resolves the SAME anchor */
/* === as a real birth at l=0 (a remote-crafted lins may legally use l=0; == */
/* === HEAD itself is never reachable this way since it is never indexed == */
/* === in byR) =============================================================== */

test("adversarial: Map's SameValueZero unifies bl=-0 with a real birth at l=0 (l=0 is a legal, non-HEAD lins lamport)", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "Q", onError: (e) => errs.push(e) });
    const l = d.list("seq");
    // A remote lins with l=0 is door-valid (finite, < 2^53) and is NOT the HEAD
    // sentinel (HEAD is never entered into byR, so this cannot collide with it).
    d.applyOp({ t: "lins", c: "seq", l: 0, r: "ghost", or: null, v: "zero-born" });
    assert.equal(errs.length, 0);
    assert.deepEqual(l.values(), ["zero-born"]);
    assert.equal(l._retention().anchors, 1);

    // A ldel naming bl=-0 (also door-valid: finite) must resolve to the SAME
    // Map slot as bl=0 (SameValueZero), and therefore correctly deletes the
    // element -- not a phantom, not a crash, not a miss.
    d.applyOp({ t: "ldel", c: "seq", l: 5, r: "peer", bl: -0, br: "ghost" });
    assert.equal(errs.length, 0);
    assert.deepEqual(l.values(), [], "bl=-0 must resolve the same anchor as a real birth at l=0");
    assert.equal(l.size, 0);
    assert.doesNotThrow(() => l._validate(d.clock()));
    d.dispose();
});

/* === H. Duplicate dispose after a populated-then-deleted list ============ */

test("duplicate dispose() after inserts+deletes is idempotent and zeroes the list structures", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    l.insert(0, "x"); l.insert(1, "y"); l.insert(2, "z");
    l.delete(1);
    assert.equal(l.size, 2);
    assert.doesNotThrow(() => doc.dispose());
    assert.doesNotThrow(() => doc.dispose());
    assert.doesNotThrow(() => doc.dispose());
    assert.deepEqual(l._retention(), { anchors: 0, elems: 0, pending: 0, unoccupied: 0, reclaimable: 0, justified: 0 }, "delete-populated list structures must be released, not just doc-flagged");
});

/* === I. Dispose-during-iteration: dispose from inside the 'change' fired == */
/* === by a LIVE ldel's ctx.changed() (the delete path DOES fire change, === */
/* === unlike the silent born-dead-placeholder reconciliation) ============= */

test("dispose-during-iteration: disposing the doc from inside 'change' fired by a live ldel does not crash", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    l.insert(0, "x"); l.insert(1, "y");

    let fired = false;
    doc.on("change", () => {
        if (fired) return;
        fired = true;
        doc.dispose(); // reentrant dispose from inside applyLdel's ctx.changed()
    });

    assert.doesNotThrow(() => l.delete(0), "dispose-during-ldel-change must not throw");
    assert.equal(fired, true);
    assert.doesNotThrow(() => doc.dispose()); // still idempotent afterward
    const r = l._retention();
    assert.equal(r.anchors, 0);
    assert.equal(r.elems, 0);
    assert.equal(r.pending, 0);
});

/* === J. Re-entrant write: a 'change' listener fired mid-ldel reentrantly = */
/* === deletes a DIFFERENT element and re-deletes the SAME (already-dead) = */
/* === element -- both must converge identically to a sequential control == */

test("re-entrant delete from a 'change' listener firing mid-ldel converges identically to a sequential control, and a re-entrant re-delete of the SAME element is a safe no-op", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "a0");
    A.list("seq").insert(1, "a1");
    A.list("seq").insert(2, "a2");
    A.dispose();
    const [a0, a1, a2] = log;

    const d = createCRDTDoc({ replicaId: "Z" });
    const l = d.list("seq");
    d.applyOps([a0, a1, a2]);
    assert.equal(l.size, 3);

    let fired = 0;
    let reentrantDeleteOp = null;
    const opsOut = [];
    capture(d, opsOut);
    d.on("change", () => {
        fired++;
        if (fired !== 1) return; // only react to the FIRST change (the a1 delete)
        // Reentrant: delete a DIFFERENT still-live element (a2) from inside the
        // change fired by a1's own delete, before applyLdel(a1-delete) returns.
        assert.equal(l.deleteById(a2.l, a2.r), true, "reentrant deleteById of a different live element must succeed");
        // Reentrant: re-delete the element CURRENTLY being deleted (a1) again,
        // from inside its own change -- must be observed as already gone/no-op,
        // never double-decrement, never double-emit.
        assert.equal(l.deleteById(a1.l, a1.r), false, "reentrant re-delete of the element already being deleted must be a no-op");
    });

    assert.doesNotThrow(() => l.deleteById(a1.l, a1.r), "reentrant-triggering delete must not throw");
    // a1's own delete fires one 'change', and the reentrant a2 delete (a real,
    // visible state change) fires a second, nested one -- both must land safely.
    assert.equal(fired, 2, "both the a1 delete and the reentrant a2 delete must each fire 'change' exactly once");
    assert.deepEqual(l.values(), ["a0"], "both a1 (direct) and a2 (reentrant) must be deleted; a0 survives");
    assert.equal(l.size, 1);

    // A THIRD reentrant delete attempt of a1 again (already gone) must be a
    // pure false no-op, not a crash, not a double-emit.
    const emittedBefore = opsOut.length;
    assert.equal(l.deleteById(a1.l, a1.r), false, "re-deleting an already-deleted element must return false");
    assert.equal(opsOut.length, emittedBefore, "a no-op re-delete must emit nothing");

    // Sequential control: apply the SAME three ops (a0,a1,a2) then the SAME two
    // deletes (a1 then a2) in plain non-reentrant order -- must converge
    // identically (commutativity means the reentrancy itself changes nothing).
    reentrantDeleteOp = opsOut.find((o) => o.bl === a2.l && o.br === a2.r);
    assert.ok(reentrantDeleteOp, "the reentrant deleteById(a2) must have emitted an ldel");
    const ctrl = createCRDTDoc({ replicaId: "C" });
    ctrl.applyOps([a0, a1, a2]);
    const delA1Op = opsOut.find((o) => o.bl === a1.l && o.br === a1.r);
    ctrl.applyOp(delA1Op);
    ctrl.applyOp(reentrantDeleteOp);
    assert.deepEqual(l.values(), ctrl.list("seq").values(), "reentrant-delete outcome diverged from the sequential control");
    assert.deepEqual(l.ids(), ctrl.list("seq").ids());

    d.dispose(); ctrl.dispose();
});

/* === K. Interleaving fuzz: N replicas, random insert+delete streams, ===== */
/* === shuffled + duplicated delivery converge to identical values()/ids() = */
/* === and validate() passes after every replay; proj.length === size ====== */
/* === (live count) holds throughout a randomized insert/delete storm ====== */

test("N-replica random insert+delete interleaving fuzz converges under shuffled+duplicated delivery; proj.length===size after every replay", () => {
    const rng = makePrng(0x5EED5EED);
    const REPLICAS = ["F1", "F2", "F3"];
    const OPS_PER_REPLICA = 30;

    const log = [];
    let tag = 0;
    for (const rid of REPLICAS) {
        const doc = createCRDTDoc({ replicaId: rid });
        capture(doc, log);
        const l = doc.list("seq");
        for (let i = 0; i < OPS_PER_REPLICA; i++) {
            const size = l.size;
            const wantDelete = size > 0 && (rng() % 100) < 30; // ~30% delete when non-empty
            if (wantDelete) {
                const idx = rng() % size;
                l.delete(idx);
            } else {
                const idx = size === 0 ? 0 : rng() % (size + 1);
                l.insert(idx, "v" + rid + "_" + (tag++));
            }
            // Local invariant holds after every single local op too.
            assert.equal(l.store.length, l.size, "proj.length !== size after a local op mid-storm");
        }
        doc.dispose();
    }
    assert.ok(log.length > 0, "the storm must have emitted at least one op");

    // Reference: single, in-order, single delivery.
    const ref = createCRDTDoc({ replicaId: "REF" });
    ref.applyOps(log);
    const refValues = ref.list("seq").values();
    const refIds = ref.list("seq").ids();
    assert.doesNotThrow(() => ref.list("seq")._validate(ref.clock()));
    assert.equal(ref.list("seq").store.length, ref.list("seq").size);
    ref.dispose();

    // Several independent shuffled + duplicated replays must all converge to
    // the identical reference, with validate() passing after EVERY replay.
    for (let trial = 0; trial < 5; trial++) {
        const flooded = [];
        for (const op of log) {
            const copies = 1 + (rng() % 3);
            for (let c = 0; c < copies; c++) flooded.push(op);
        }
        const delivered = shuffle(flooded, rng);
        const d = createCRDTDoc({ replicaId: "T" + trial });
        d.applyOps(delivered);
        const dl = d.list("seq");
        assert.deepEqual(dl.values(), refValues, "trial " + trial + ": values diverged under shuffled+duplicated delivery");
        assert.deepEqual(dl.ids(), refIds, "trial " + trial + ": ids diverged under shuffled+duplicated delivery");
        assert.equal(dl.store.length, dl.size, "trial " + trial + ": proj.length !== size after the storm replay");
        assert.doesNotThrow(() => dl._validate(d.clock()), "trial " + trial + ": structural invariant broke after the storm replay");
        // Re-delivering the whole flooded log again on top of convergence is a
        // pure no-op (idempotence at scale, with deletes in the mix).
        d.applyOps(delivered);
        assert.deepEqual(dl.values(), refValues);
        assert.equal(dl.store.length, dl.size);
        d.dispose();
    }
});
