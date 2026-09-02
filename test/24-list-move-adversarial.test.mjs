// C5.3 QA gap-fill: boundary matrix + adversarial cases for the RGA list MOVE
// surface (lmv) that test/23-list-move.test.mjs (the coder's suite) and
// test/20-list-door.test.mjs / test/22-list-delete-adversarial.test.mjs do not
// already cover. Scope: lins+ldel+lmv apply only (no serialization/delta/
// compaction -- that is C5.4). Covers: the move(from,to) boundary matrix (0, 1,
// N-1, N, N+1, empty, null, undefined, NaN, -0), the toIndex convention pinned
// against the `arr.splice` reference, duplicate dispose / dispose-during-
// iteration / a re-entrant move, the lmv door's own fail-closed matrix
// (mirroring the lins/ldel matrices) including proto-poison ids, the born==null
// case for BOTH ldel and lmv when a crafted frame names a REAL move-anchor id
// (not a birth) as its target, direct abandoned-anchor accounting via
// _retention(), move-then-delete/delete-then-move via the LOCAL API, an
// N-replica mixed insert/delete/move fuzz, and an adversarial self-referential
// lmv origin the planner's spec did not anticipate.
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

function freshList(n) {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    for (let i = 0; i < n; i++) l.insert(i, "e" + i);
    return { doc, l };
}

/* === A. move(from, to) boundary matrix: 0, 1, N-1, N, N+1, empty, null, ===== */
/* === undefined, NaN, -0, for BOTH `from` and `to` =========================== */

test("move(from, to): `from` boundary matrix on N=5 (to fixed at 0) -- 0/1/N-1 valid, N/N+1/-1/frac/NaN/+-Inf/null/undef invalid, -0 === 0", () => {
    const isMis = (e) => e && e.code === "misconfigured";

    // 0 (already at destination: a self-move-like relocation, still valid)
    { const { doc, l } = freshList(5); assert.equal(l.move(0, 0), true); assert.deepEqual(l.values(), ["e0", "e1", "e2", "e3", "e4"]); doc.dispose(); }
    // 1 (valid: moves e1 to front)
    { const { doc, l } = freshList(5); assert.equal(l.move(1, 0), true); assert.deepEqual(l.values(), ["e1", "e0", "e2", "e3", "e4"]); doc.dispose(); }
    // N-1 = 4 (valid: moves the last element to front)
    { const { doc, l } = freshList(5); assert.equal(l.move(4, 0), true); assert.deepEqual(l.values(), ["e4", "e0", "e1", "e2", "e3"]); doc.dispose(); }
    // N = 5: invalid (one past the last live element)
    { const { doc, l } = freshList(5); assert.throws(() => l.move(5, 0), isMis); assert.equal(l.size, 5); doc.dispose(); }
    // N+1 = 6: invalid
    { const { doc, l } = freshList(5); assert.throws(() => l.move(6, 0), isMis); assert.equal(l.size, 5); doc.dispose(); }
    // -1: invalid
    { const { doc, l } = freshList(5); assert.throws(() => l.move(-1, 0), isMis); doc.dispose(); }
    // fractional: invalid
    { const { doc, l } = freshList(5); assert.throws(() => l.move(2.5, 0), isMis); doc.dispose(); }
    // NaN / +Inf / -Inf / null / undefined: invalid
    { const { doc, l } = freshList(5);
        for (const bad of [NaN, Infinity, -Infinity, null, undefined]) {
            assert.throws(() => l.move(bad, 0), isMis, "move(" + String(bad) + ", 0) must throw");
        }
        assert.equal(l.size, 5);
        doc.dispose();
    }
    // -0 is Number.isInteger(-0) === true and behaves EXACTLY like index 0
    { const { doc, l } = freshList(5); assert.equal(l.move(-0, 1), true); assert.deepEqual(l.values(), ["e1", "e0", "e2", "e3", "e4"]); doc.dispose(); }
});

test("move(from, to): `to` boundary matrix on N=5 (from fixed at 2) -- 0/1/N-1 valid, N/N+1/-1/frac/Inf/null/undef invalid, -0 === 0", () => {
    const isMis = (e) => e && e.code === "misconfigured";

    // 0 (front)
    { const { doc, l } = freshList(5); assert.equal(l.move(2, 0), true); assert.deepEqual(l.values(), ["e2", "e0", "e1", "e3", "e4"]); doc.dispose(); }
    // 1
    { const { doc, l } = freshList(5); assert.equal(l.move(2, 1), true); assert.deepEqual(l.values(), ["e0", "e2", "e1", "e3", "e4"]); doc.dispose(); }
    // N-1 = 4 (post-removal tail)
    { const { doc, l } = freshList(5); assert.equal(l.move(2, 4), true); assert.deepEqual(l.values(), ["e0", "e1", "e3", "e4", "e2"]); doc.dispose(); }
    // N = 5: invalid (post-removal range is 0..size-1, not 0..size)
    { const { doc, l } = freshList(5); assert.throws(() => l.move(2, 5), isMis); assert.equal(l.size, 5); doc.dispose(); }
    // N+1 = 6: invalid
    { const { doc, l } = freshList(5); assert.throws(() => l.move(2, 6), isMis); doc.dispose(); }
    // -1: invalid
    { const { doc, l } = freshList(5); assert.throws(() => l.move(2, -1), isMis); doc.dispose(); }
    // fractional / Infinity / null / undefined: invalid
    { const { doc, l } = freshList(5);
        for (const bad of [1.5, Infinity, -Infinity, NaN, null, undefined]) {
            assert.throws(() => l.move(2, bad), isMis, "move(2, " + String(bad) + ") must throw");
        }
        assert.equal(l.size, 5);
        doc.dispose();
    }
    // -0 behaves exactly like 0
    { const { doc, l } = freshList(5); assert.equal(l.move(2, -0), true); assert.deepEqual(l.values(), ["e2", "e0", "e1", "e3", "e4"]); doc.dispose(); }
});

test("move() on an EMPTY list fails closed for every from/to combination, including (0,0)", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    const isMis = (e) => e && e.code === "misconfigured";
    assert.throws(() => l.move(0, 0), isMis, "move(0,0) on an empty list must throw: size 0 has no valid index");
    assert.throws(() => l.move(-0, -0), isMis);
    assert.equal(l.size, 0);
    doc.dispose();
});

/* === B. move(from, to) toIndex convention PINNED against the arr.splice ===== */
/* === reference: arr.splice(to, 0, arr.splice(from, 1)[0]) =================== */

test("move(from, to) is pinned against arr.splice(to,0,arr.splice(from,1)[0]) for a spread of (from,to) pairs on N=6", () => {
    const N = 6;
    const pairs = [
        [0, 0], [0, 5], [5, 0], [2, 2], [2, 4], [4, 1], [0, 4], [5, 4], [3, 3], [1, 0], [4, 5], [5, 5],
    ];
    for (const [from, to] of pairs) {
        const ref = [];
        for (let i = 0; i < N; i++) ref.push("e" + i);
        ref.splice(to, 0, ref.splice(from, 1)[0]);

        const { doc, l } = freshList(N);
        l.move(from, to);
        assert.deepEqual(l.values(), ref, "move(" + from + "," + to + ") diverged from the arr.splice reference");
        doc.dispose();
    }
});

/* === C. Duplicate dispose / dispose-during-iteration / re-entrant write ===== */

test("duplicate dispose() after moves (including an abandoned anchor) is idempotent and zeroes list structures", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    l.insert(0, "x"); l.insert(1, "y"); l.insert(2, "z");
    l.move(0, 2);   // mints a real move anchor
    assert.equal(l.size, 3);
    assert.ok(l._retention().anchors >= 4, "expected at least 3 births + 1 move anchor");
    assert.doesNotThrow(() => doc.dispose());
    assert.doesNotThrow(() => doc.dispose());
    assert.doesNotThrow(() => doc.dispose());
    assert.deepEqual(l._retention(), { anchors: 0, elems: 0, pending: 0, unoccupied: 0, reclaimable: 0, justified: 0 }, "move-populated list structures must be released, not just doc-flagged");
});

test("dispose-during-iteration: disposing the doc from inside 'change' fired by a live lmv does not crash", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    l.insert(0, "x"); l.insert(1, "y");

    let fired = false;
    doc.on("change", () => {
        if (fired) return;
        fired = true;
        doc.dispose(); // reentrant dispose from inside applyLmv's ctx.changed()
    });

    assert.doesNotThrow(() => l.move(0, 1), "dispose-during-lmv-change must not throw");
    assert.equal(fired, true);
    assert.doesNotThrow(() => doc.dispose()); // still idempotent afterward
    const r = l._retention();
    assert.equal(r.anchors, 0);
    assert.equal(r.elems, 0);
    assert.equal(r.pending, 0);
});

test("re-entrant move from a 'change' listener firing mid-lmv converges identically regardless of delivery order (true composition under reentrancy)", () => {
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
    d.applyOps([a0, a1, a2]); // [a0, a1, a2]

    let fired = 0;
    const opsOut = [];
    capture(d, opsOut);
    d.on("change", () => {
        fired++;
        if (fired !== 1) return; // react only to the outer move's own change
        // Reentrant: move the CURRENT last live element to the front, from
        // inside the 'change' fired by the OUTER move's own ctx.changed(),
        // before the outer applyLmv call returns.
        const sz = l.size;
        assert.doesNotThrow(() => l.move(sz - 1, 0), "reentrant move must not throw");
    });

    assert.doesNotThrow(() => l.move(0, 2), "outer move must not throw despite the reentrant write");
    assert.ok(fired >= 1, "the outer move must have fired 'change'");
    assert.equal(opsOut.length, 2, "exactly the reentrant move and the outer move must have emitted");
    const [reentrantOp, outerOp] = opsOut; // reentrant's emit completes before the outer's (see comment above)
    assert.equal(reentrantOp.t, "lmv"); assert.equal(outerOp.t, "lmv");
    assert.ok(reentrantOp.l > outerOp.l, "the reentrant move must carry a strictly later stamp (ticked after the outer op)");

    const finalValues = l.values();
    const finalIds = l.ids();

    // Sequential control, causal order: converges identically.
    const ctrl = createCRDTDoc({ replicaId: "C" });
    ctrl.applyOp(a0); ctrl.applyOp(a1); ctrl.applyOp(a2);
    ctrl.applyOp(outerOp); ctrl.applyOp(reentrantOp);
    assert.deepEqual(ctrl.list("seq").values(), finalValues, "sequential (causal-order) control diverged from the reentrant outcome");
    assert.deepEqual(ctrl.list("seq").ids(), finalIds);

    // A second control receiving the two moves in the OPPOSITE order must
    // converge to the SAME result -- commutativity, not an artifact of order.
    const ctrl2 = createCRDTDoc({ replicaId: "C2" });
    ctrl2.applyOp(a0); ctrl2.applyOp(a1); ctrl2.applyOp(a2);
    ctrl2.applyOp(reentrantOp); ctrl2.applyOp(outerOp);
    assert.deepEqual(ctrl2.list("seq").values(), finalValues, "opposite-order control diverged -- moves are not commuting correctly");
    assert.deepEqual(ctrl2.list("seq").ids(), finalIds);

    d.dispose(); ctrl.dispose(); ctrl2.dispose();
});

/* === D. The lmv door's own fail-closed matrix (mirrors the lins/ldel ======= */
/* === matrices in test/20-list-door.test.mjs / test/22-list-delete- ========= */
/* === adversarial.test.mjs), including proto-poison ids ===================== */

function feedRemoteLmv(fields, seedInsert = true) {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const l = d.list("seq");
    if (seedInsert) l.insert(0, "seed"); // birth anchor (l=1, r="R")
    const op = Object.assign({ t: "lmv", c: "seq", l: 9, r: "peer", bl: 1, br: "R", or: null, ol: undefined }, fields);
    d.applyOp(op);
    return { d, l, errs };
}

test("door: lmv's OWN l/r boundary -- non-finite/ceiling l and empty/non-string r are rejected; -0 and 2^53-1 are accepted", () => {
    for (const badL of [NaN, Infinity, -Infinity, MAX_LAMPORT, MAX_LAMPORT + 1, "5", null, undefined]) {
        const { d, l, errs } = feedRemoteLmv({ l: badL });
        assert.equal(errs.length, 1, "lmv l=" + String(badL) + " must be rejected");
        assert.deepEqual(l.values(), ["seed"], "a door-rejected lmv must not touch the seed");
        assert.equal(l._retention().anchors, 1, "a door-rejected lmv must never mint an anchor");
        d.dispose();
    }
    { const { d, l, errs } = feedRemoteLmv({ l: MAX_LAMPORT - 1 }); assert.equal(errs.length, 0); assert.equal(l._retention().anchors, 2); d.dispose(); }
    { const { d, l, errs } = feedRemoteLmv({ l: -0 }); assert.equal(errs.length, 0, "-0 is finite and must be accepted"); assert.equal(l._retention().anchors, 2); d.dispose(); }

    for (const badR of ["", null, undefined, 5, {}]) {
        const { d, l, errs } = feedRemoteLmv({ r: badR });
        assert.equal(errs.length, 1, "lmv r=" + String(badR) + " must be rejected");
        assert.equal(l._retention().anchors, 1);
        d.dispose();
    }
});

test("door: lmv bl/br (the target birth anchor) -- fail-closed matrix; bl=0/-1 and br='__proto__' are door-VALID placeholders", () => {
    for (const badBl of [NaN, Infinity, -Infinity, MAX_LAMPORT, MAX_LAMPORT + 1, "1", null, undefined, {}]) {
        const { d, l, errs } = feedRemoteLmv({ bl: badBl });
        assert.equal(errs.length, 1, "lmv bl=" + String(badBl) + " must be rejected");
        assert.deepEqual(l.values(), ["seed"]);
        assert.equal(l._retention().anchors, 1, "a door-rejected lmv must never mint an anchor");
        assert.equal(l._retention().pending, 0);
        d.dispose();
    }
    for (const badBr of ["", null, undefined, 5, {}, []]) {
        const { d, l, errs } = feedRemoteLmv({ br: badBr });
        assert.equal(errs.length, 1, "lmv br=" + String(badBr) + " must be rejected");
        assert.equal(l._retention().anchors, 1);
        d.dispose();
    }
    // Door-VALID but fictional targets: harmless born-moved placeholders (the
    // anchor still mints unconditionally), no error, seed untouched.
    { const { d, l, errs } = feedRemoteLmv({ bl: 0, br: "ghost" }); assert.equal(errs.length, 0); assert.deepEqual(l.values(), ["seed"]); assert.equal(l._retention().pending, 1); assert.equal(l._retention().anchors, 2); d.dispose(); }
    { const { d, l, errs } = feedRemoteLmv({ bl: -1, br: "ghost" }); assert.equal(errs.length, 0); assert.equal(l._retention().pending, 1); d.dispose(); }
    {
        const protoBefore = Object.getOwnPropertyNames(Object.prototype).length;
        const { d, l, errs } = feedRemoteLmv({ bl: 1, br: "__proto__" });
        assert.equal(errs.length, 0, "'__proto__' is a syntactically legal string id");
        assert.deepEqual(l.values(), ["seed"]);
        assert.equal(l._retention().pending, 1);
        assert.equal(Object.getOwnPropertyNames(Object.prototype).length, protoBefore, "Object.prototype must be untouched");
        assert.equal(({}).polluted, undefined);
        d.dispose();
    }
});

test("door: lmv or/ol (the destination origin) -- null (HEAD) accepted, empty/number/object rejected, bad ol rejected, proto-poison 'or' accepted and pends", () => {
    { const { d, l, errs } = feedRemoteLmv({ or: null }); assert.equal(errs.length, 0); assert.equal(l._retention().anchors, 2); d.dispose(); }
    for (const bad of ["", 5, {}, [], true]) {
        const { d, l, errs } = feedRemoteLmv({ or: bad, ol: 1 });
        assert.equal(errs.length, 1, "lmv or=" + JSON.stringify(bad) + " must be rejected");
        assert.equal(l._retention().anchors, 1, "a door-rejected lmv must never mint an anchor");
        d.dispose();
    }
    for (const badOl of [NaN, Infinity, -Infinity, MAX_LAMPORT, "1", null, undefined, {}]) {
        const { d, l, errs } = feedRemoteLmv({ or: "ghost", ol: badOl });
        assert.equal(errs.length, 1, "lmv ol=" + String(badOl) + " with a valid non-null or must be rejected");
        assert.equal(l._retention().anchors, 1);
        assert.equal(l._retention().pending, 0, "a door-rejected op must never reach the pending buffer");
        d.dispose();
    }
    // A door-VALID or/ol pair whose anchor does not exist: PENDS (unconditional
    // mint deferred until the origin resolves), never a rejection.
    {
        const { d, l, errs } = feedRemoteLmv({ or: "ghost", ol: MAX_LAMPORT - 1 });
        assert.equal(errs.length, 0);
        assert.equal(l._retention().pending, 1);
        assert.equal(l._retention().anchors, 1, "the destination anchor cannot mint before its OWN origin resolves");
        d.dispose();
    }
    // "__proto__" as an origin id is safe (Map-keyed): accepted, held pending.
    {
        const { d, l, errs } = feedRemoteLmv({ or: "__proto__", ol: 1 });
        assert.equal(errs.length, 0);
        assert.equal(l._retention().pending, 1);
        d.dispose();
    }
    // proto-poison replicaId (r) on a well-formed lmv applies safely.
    {
        const protoBefore = Object.getOwnPropertyNames(Object.prototype).length;
        const { d, l, errs } = feedRemoteLmv({ r: "__proto__" });
        assert.equal(errs.length, 0, "'__proto__' is a syntactically legal replicaId");
        assert.equal(l._retention().anchors, 2, "the move anchor still mints under a proto-poison replicaId");
        assert.equal(Object.getOwnPropertyNames(Object.prototype).length, protoBefore);
        assert.equal(({}).polluted, undefined);
        d.dispose();
    }
});

/* === E. born==null: a crafted ldel/lmv naming a REAL move-anchor id (not a = */
/* === birth) as its target fails closed to a placeholder, never touches the = */
/* === real element, and the real element remains fully addressable by its === */
/* === true birth identity afterward ========================================= */

test("born==null: crafted ldel/lmv naming an existing MOVE-ANCHOR id (not a birth) fail closed to a placeholder, never touch the real element", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "x"); // birth (1,"A")
    A.list("seq").insert(1, "y"); // birth (2,"A")
    A.list("seq").insert(2, "z"); // birth (3,"A")
    A.list("seq").move(1, 1);    // self-move "y": mints a REAL move anchor M (occupied by "y")
    A.dispose();
    const moveOp = log.find((o) => o.t === "lmv");
    assert.ok(moveOp, "the move must have emitted an lmv");
    const M = { l: moveOp.l, r: moveOp.r }; // the move anchor's own id -- NOT a birth

    const errs = [];
    const d = createCRDTDoc({ replicaId: "Z", onError: (e) => errs.push(e) });
    d.applyOps(log);
    const l = d.list("seq");
    assert.deepEqual(l.values(), ["x", "y", "z"], "baseline: y occupies the move anchor after the self-move");
    const pendingBefore = l._retention().pending;

    // A crafted ldel naming the MOVE ANCHOR's id as a "birth" (bl=M.l, br=M.r):
    // birthNode exists (it's the move anchor node) but birthNode.born === null
    // (only real birth nodes carry a `born` back-pointer) -- must fail closed to
    // a delete-before-insert placeholder, NOT delete "y".
    assert.doesNotThrow(() => d.applyOp({ t: "ldel", c: "seq", l: 100, r: "att", bl: M.l, br: M.r }));
    assert.equal(errs.length, 0, "a door-valid ldel naming a move-anchor id is not a rejection, just a fail-closed placeholder");
    assert.deepEqual(l.values(), ["x", "y", "z"], "y must survive an ldel that names its DISPLAY anchor instead of its birth");
    assert.equal(l._retention().pending, pendingBefore + 1, "the ldel must be held as a (never-resolving) placeholder");

    // A crafted lmv naming the MOVE ANCHOR's id as a "birth" target similarly
    // fails closed to a born-moved placeholder, never relocating "y".
    assert.doesNotThrow(() => d.applyOp({ t: "lmv", c: "seq", l: 101, r: "att2", bl: M.l, br: M.r, or: null, ol: undefined }));
    assert.equal(errs.length, 0);
    assert.deepEqual(l.values(), ["x", "y", "z"], "y must survive an lmv that names its DISPLAY anchor instead of its birth");
    assert.equal(l._retention().pending, pendingBefore + 2, "the lmv must also be held as a (never-resolving) placeholder");

    // The real "y" (true birth (2,"A")) remains fully addressable afterward.
    assert.equal(d.list("seq").deleteById(2, "A"), true, "y must still be deletable by its TRUE birth identity");
    assert.deepEqual(l.values(), ["x", "z"]);
    assert.doesNotThrow(() => l._validate(d.clock()));
    d.dispose();
});

/* === F. Abandoned-anchor accounting, measured directly via _retention() ==== */

test("abandoned-anchor accounting: _retention().anchors is identical on both replicas and equals births + move-anchors, deterministically; _validate() passes", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "a"); // (1,"A")
    A.list("seq").insert(1, "b"); // (2,"A")
    A.list("seq").insert(2, "c"); // (3,"A")
    A.dispose();
    const base = log;

    // 4 concurrent moves total: two moves each of "a" and "c" (never "b"),
    // distinct stamps, so exactly 3 births + 4 move anchors = 7 anchors on
    // EVERY replica regardless of delivery order (abandoned losers included).
    const M1 = { t: "lmv", c: "seq", l: 10, r: "X1", bl: 1, br: "A", or: null, ol: undefined };   // move "a" to head
    const M2 = { t: "lmv", c: "seq", l: 11, r: "Y1", bl: 1, br: "A", or: "A", ol: 3 };            // move "a" to tail (wins)
    const M3 = { t: "lmv", c: "seq", l: 12, r: "X2", bl: 3, br: "A", or: null, ol: undefined };   // move "c" to head
    const M4 = { t: "lmv", c: "seq", l: 13, r: "Y2", bl: 3, br: "A", or: "A", ol: 1 };            // move "c" after "a" (wins)

    const R1 = createCRDTDoc({ replicaId: "R1" });
    R1.applyOps(base); R1.applyOp(M1); R1.applyOp(M2); R1.applyOp(M3); R1.applyOp(M4);
    const R2 = createCRDTDoc({ replicaId: "R2" });
    R2.applyOps(base); R2.applyOp(M4); R2.applyOp(M3); R2.applyOp(M2); R2.applyOp(M1);

    assert.equal(R1.list("seq")._retention().anchors, 7, "3 births + 4 move anchors, deterministic regardless of arrival order");
    assert.equal(R2.list("seq")._retention().anchors, 7, "R2 must account identically to R1");
    assert.equal(R1.list("seq")._retention().anchors, R2.list("seq")._retention().anchors);
    assert.equal(R1.list("seq")._retention().elems, 3, "elems tracks LIVE elements, not anchors (no births/deletes here)");
    assert.equal(R2.list("seq")._retention().elems, 3);
    assert.equal(JSON.stringify(R1.snapshot()), JSON.stringify(R2.snapshot()));
    assert.doesNotThrow(() => R1.list("seq")._validate(R1.clock()));
    assert.doesNotThrow(() => R2.list("seq")._validate(R2.clock()));

    R1.dispose(); R2.dispose();
});

/* === G. Move-then-delete / delete-then-move via the LOCAL API =============== */

test("move-then-delete and delete-then-move (LOCAL API) converge to invisible on all replicas; ids() drops it; deleteById by birth still works after a move", () => {
    // Case 1: move locally, then deleteById locally (on the SAME doc) -- the
    // element must vanish from values()/ids(), and _retention().elems must drop.
    {
        const doc = createCRDTDoc({ replicaId: "A" });
        const l = doc.list("seq");
        const idA = l.insert(0, "a"); // "A#1"
        l.insert(1, "b");             // "A#2"
        l.move(0, 1);                 // move "a" after "b" -> [b, a], mints a real anchor
        assert.deepEqual(l.values(), ["b", "a"]);
        assert.equal(idA, "A#1");
        assert.equal(l.deleteById(1, "A"), true, "deleteById must still resolve by BIRTH identity after a move");
        assert.deepEqual(l.values(), ["b"], "a must be invisible after move-then-delete");
        assert.deepEqual(l.ids(), ["A#2"], "ids() must no longer list the moved-then-deleted element");
        assert.equal(l._retention().elems, 1);
        doc.dispose();
    }
    // Case 2: delete then move -- move of an already-deleted element (identified
    // by birth) must be an invisible no-op (register still updates, no resurrection).
    {
        const A = createCRDTDoc({ replicaId: "A" });
        const log = [];
        capture(A, log);
        A.list("seq").insert(0, "a"); // (1,"A")
        A.list("seq").insert(1, "b"); // (2,"A")
        A.dispose();
        const [insA, insB] = log;

        const R1 = createCRDTDoc({ replicaId: "R1" });
        const R2 = createCRDTDoc({ replicaId: "R2" });
        const del = { t: "ldel", c: "seq", l: 5, r: "peer", bl: 1, br: "A" };  // delete "a"
        const mv = { t: "lmv", c: "seq", l: 6, r: "peer2", bl: 1, br: "A", or: null, ol: undefined }; // move "a"
        R1.applyOps([insA, insB]); R1.applyOp(del); R1.applyOp(mv);   // delete then move
        R2.applyOps([insA, insB]); R2.applyOp(mv); R2.applyOp(del);   // move then delete
        assert.deepEqual(R1.list("seq").values(), ["b"], "R1: a stays invisible regardless of delivery order");
        assert.deepEqual(R2.list("seq").values(), ["b"], "R2: same");
        assert.deepEqual(R1.list("seq").ids(), ["A#2"]);
        assert.deepEqual(R2.list("seq").ids(), ["A#2"]);
        assert.equal(JSON.stringify(R1.snapshot()), JSON.stringify(R2.snapshot()));
        R1.dispose(); R2.dispose();
    }
});

/* === H. N-replica mixed insert/delete/move fuzz: proj.length===size after == */
/* === every LOCAL op mid-storm; validate() passes after every replay ======== */

test("N-replica mixed insert/delete/move fuzz converges under shuffled+duplicated delivery; proj.length===size throughout, validate() after every replay", () => {
    const rng = makePrng(0xFEEDFACE);
    const REPLICAS = ["G1", "G2", "G3"];
    const OPS_PER_REPLICA = 24;

    const log = [];
    let tag = 0;
    for (const rid of REPLICAS) {
        const doc = createCRDTDoc({ replicaId: rid });
        capture(doc, log);
        const l = doc.list("seq");
        for (let i = 0; i < OPS_PER_REPLICA; i++) {
            const size = l.size;
            const roll = rng() % 3;
            if (size === 0 || roll === 0) {
                l.insert(size === 0 ? 0 : rng() % (size + 1), "v" + rid + "_" + (tag++));
            } else if (roll === 1) {
                l.delete(rng() % size);
            } else {
                const from = rng() % size;
                const to = rng() % size;
                l.move(from, to);
            }
            // Local invariant holds after every single local op mid-storm.
            assert.equal(l.store.length, l.size, "proj.length !== size after a local op mid-storm (" + rid + "#" + i + ")");
        }
        assert.doesNotThrow(() => l._validate(doc.clock()), "local structural invariant broke mid-storm on " + rid);
        doc.dispose();
    }
    assert.ok(log.length > 0);

    const ref = createCRDTDoc({ replicaId: "REF" });
    ref.applyOps(log);
    const refValues = ref.list("seq").values();
    const refIds = ref.list("seq").ids();
    assert.doesNotThrow(() => ref.list("seq")._validate(ref.clock()));
    ref.dispose();

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
        assert.deepEqual(dl.values(), refValues, "trial " + trial + ": values diverged");
        assert.deepEqual(dl.ids(), refIds, "trial " + trial + ": ids diverged");
        assert.equal(dl.store.length, dl.size, "trial " + trial + ": proj.length !== size");
        assert.doesNotThrow(() => dl._validate(d.clock()), "trial " + trial + ": structural invariant broke");
        d.applyOps(delivered); // idempotence at scale, with moves in the mix
        assert.deepEqual(dl.values(), refValues);
        assert.equal(dl.store.length, dl.size);
        d.dispose();
    }
});

/* === I. Adversarial: a self-referential lmv origin (the planner did not ==== */
/* === anticipate) can NEVER resolve -- a crafted lmv naming its OWN not-yet- */
/* === minted anchor id as its own destination origin is neither a legitimate */
/* === "not arrived yet" pend nor a door rejection: it is a logical ========== */
/* === impossibility, and MUST still fail closed (bounded, no crash, no ====== */
/* === infinite loop) rather than silently corrupt or hang ==================== */

test("adversarial: an lmv naming its OWN about-to-be-minted anchor as its destination origin can never resolve -- bounded, no crash, redelivery is capped not unbounded", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "SR", onError: (e) => errs.push(e) });
    const l = d.list("seq");
    // or === r, ol === l: this lmv names ITSELF as the anchor its own
    // destination origin resolves to -- an anchor that (by definition) cannot
    // exist yet, since minting only happens AFTER the origin resolves. It is
    // door-valid (l finite, r non-empty, bl/br well-formed, or non-empty string
    // with finite ol) but can NEVER integrate under any future delivery.
    const selfOp = { t: "lmv", c: "seq", l: 5, r: "X", bl: 1, br: "ghost", or: "X", ol: 5 };

    assert.doesNotThrow(() => d.applyOp(selfOp));
    assert.equal(errs.length, 0, "a self-referential lmv is door-valid: it is pended, not rejected");
    assert.equal(l._retention().anchors, 0, "the anchor can never mint: its own origin resolution depends on itself");
    assert.equal(l._retention().pending, 1);
    assert.equal(l.size, 0);

    // Redelivering the SAME impossible frame again is NOT deduped (pending
    // dedup is deferred to drain time, and this op can never drain) -- each
    // redelivery queues a fresh pending copy. This must still be bounded by
    // the shared PENDING_MAX budget, exactly like any other crafted-frame flood.
    const PENDING_MAX = 4096;
    const FLOOD = PENDING_MAX + 20;
    for (let i = 0; i < FLOOD; i++) {
        assert.doesNotThrow(() => d.applyOp(selfOp), "redelivering a self-referential lmv must never throw");
    }
    assert.equal(l._retention().pending, PENDING_MAX, "a never-resolving self-referential lmv must still cap at PENDING_MAX");
    assert.ok(errs.length >= 15, "overflow copies past the cap must be reported");
    assert.equal(l._retention().anchors, 0, "still never mints, no matter how many times it is redelivered");
    assert.doesNotThrow(() => l._validate(d.clock()), "doc must stay structurally valid under an unresolvable self-referential lmv flood");

    // The doc remains fully usable: a genuine local insert and a genuine
    // well-formed remote move still apply after the impossible-frame flood.
    assert.doesNotThrow(() => l.insert(0, "good"));
    assert.equal(l.size, 1);
    assert.doesNotThrow(() => l.move(0, 0));
    assert.equal(l.size, 1);
    d.dispose();
});
