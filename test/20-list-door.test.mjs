// C5.1 QA gap-fill: boundary matrix + adversarial cases for doc.list(name) that
// test/19-list-order.test.mjs does not already cover -- the lins door rejection
// matrix, prototype/boxed-primitive poison, the pending-buffer DoS cap,
// idempotence under arbitrary duplication at scale, out-of-order + duplicate
// combined, reentrant LOCAL writes during a drain, and duplicate-dispose /
// dispose-during-iteration. `lins` and `ldel` apply as of C5.2 (delete SEMANTICS
// are covered in depth by test/21-list-delete.test.mjs); a well-formed `lmv`
// frame is asserted only to not crash and to be door-rejected (move is C5.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

const MAX_LAMPORT = 2 ** 53;

/** Deterministic xorshift32 PRNG, seeded, for reproducible shuffles. */
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
function capture(doc, sink) { doc.on("op", (op) => sink.push(op)); }

/* === A. insert(index) boundary matrix: 0,1,N-1,N,N+1,empty,null,undefined, ===
   === NaN,-0, non-integer ============================================== */

test("insert(index) boundary matrix on an N=3 list", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    // empty list: index 0 (=N) is the only legal call
    assert.throws(() => l.insert(1, "bad"), (e) => e.code === "misconfigured", "N+1 on empty (N=0) must throw");
    l.insert(0, "x"); l.insert(1, "y"); l.insert(2, "z"); // build N=3: x,y,z
    assert.equal(l.size, 3);

    // 0 (prepend), 1 (middle), N-1=2 (before last) are all legal insert points
    // on a size-3 list; verify each lands where expected without mutating size
    // beyond the one insertion (checked via a snapshot before/after each probe
    // on a disposable clone-by-reinsert pattern is overkill here -- assert only
    // the throw/no-throw boundary + one representative placement).
    assert.doesNotThrow(() => l.insert(0, "p0"));   // 0
    assert.doesNotThrow(() => l.insert(1, "p1"));   // 1
    assert.equal(l.size, 5);
    assert.doesNotThrow(() => l.insert(l.size - 1, "pNm1")); // N-1 (before last)
    assert.doesNotThrow(() => l.insert(l.size, "pN"));       // N (append)
    const size = l.size;
    assert.throws(() => l.insert(size + 1, "pN+1"), (e) => e.code === "misconfigured", "N+1 must throw");
    assert.throws(() => l.insert(-1, "neg"), (e) => e.code === "misconfigured");
    assert.throws(() => l.insert(1.5, "frac"), (e) => e.code === "misconfigured", "non-integer must throw");
    assert.throws(() => l.insert(NaN, "nan"), (e) => e.code === "misconfigured", "NaN must throw");
    assert.throws(() => l.insert(Infinity, "inf"), (e) => e.code === "misconfigured", "Infinity must throw");
    assert.throws(() => l.insert(null, "null"), (e) => e.code === "misconfigured", "null must throw");
    assert.throws(() => l.insert(undefined, "undef"), (e) => e.code === "misconfigured", "undefined must throw");
    // -0 is a legal integer index equal to 0 (Number.isInteger(-0) === true)
    const beforeSize = l.size;
    assert.doesNotThrow(() => l.insert(-0, "negzero"));
    assert.equal(l.size, beforeSize + 1);
    assert.equal(l.values()[0], "negzero", "-0 must behave exactly like index 0");
    doc.dispose();
});

/* === B/C/D. The lins door: fail-closed matrix for l, r, or, ol =========== */

function feedRemoteLins(fields) {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const op = Object.assign({ t: "lins", c: "seq", l: 1, r: "peer", or: null, v: "v" }, fields);
    d.applyOp(op);
    return { d, errs };
}

test("door: lins l boundary -- 2^53-1 accepted, 2^53 and 2^53+1 rejected, NaN/Infinity/-Infinity rejected, -0 accepted", () => {
    { const { d, errs } = feedRemoteLins({ l: MAX_LAMPORT - 1 }); assert.equal(errs.length, 0); assert.equal(d.list("seq").size, 1); d.dispose(); }
    { const { d, errs } = feedRemoteLins({ l: MAX_LAMPORT }); assert.equal(errs.length, 1); assert.equal(d.list("seq").size, 0); d.dispose(); }
    { const { d, errs } = feedRemoteLins({ l: MAX_LAMPORT + 1 }); assert.equal(errs.length, 1); assert.equal(d.list("seq").size, 0); d.dispose(); }
    { const { d, errs } = feedRemoteLins({ l: NaN }); assert.equal(errs.length, 1); assert.equal(d.list("seq").size, 0); d.dispose(); }
    { const { d, errs } = feedRemoteLins({ l: Infinity }); assert.equal(errs.length, 1); assert.equal(d.list("seq").size, 0); d.dispose(); }
    { const { d, errs } = feedRemoteLins({ l: -Infinity }); assert.equal(errs.length, 1); assert.equal(d.list("seq").size, 0); d.dispose(); }
    { const { d, errs } = feedRemoteLins({ l: -0 }); assert.equal(errs.length, 0, "-0 is finite and < 2^53; must be accepted"); assert.equal(d.list("seq").size, 1); d.dispose(); }
    { const { d, errs } = feedRemoteLins({ l: null }); assert.equal(errs.length, 1); d.dispose(); }
    { const { d, errs } = feedRemoteLins({ l: undefined }); assert.equal(errs.length, 1); d.dispose(); }
    // eslint-disable-next-line no-new-wrappers
    { const { d, errs } = feedRemoteLins({ l: new Number(1) }); assert.equal(errs.length, 1, "a boxed Number must not satisfy typeof === 'number'"); d.dispose(); }
});

test("door: lins r boundary -- empty/null/undefined/NaN/boxed rejected; '__proto__' is a valid id and applies safely", () => {
    for (const bad of ["", null, undefined, NaN, 5]) {
        const { d, errs } = feedRemoteLins({ r: bad });
        assert.equal(errs.length, 1, "r=" + String(bad) + " must be rejected");
        assert.equal(d.list("seq").size, 0);
        d.dispose();
    }
    // eslint-disable-next-line no-new-wrappers
    { const { d, errs } = feedRemoteLins({ r: new String("peer") }); assert.equal(errs.length, 1, "a boxed String must not satisfy typeof === 'string'"); d.dispose(); }

    // "__proto__" is a syntactically valid non-empty string id: the door has no
    // reason to special-case it (unlike LWW-Map's op.k or OR-Set's plain-object
    // getState shape) because RGA list identity lives ONLY in real Map keys
    // (byR: Map(r -> Map(l -> node)), pending: Map("or#ol" -> ...)) -- never a
    // bare object property. Assert it applies correctly and does not touch
    // Object.prototype / Array.prototype.
    {
        const protoBefore = Object.getOwnPropertyNames(Object.prototype).length;
        const arrProtoBefore = Object.getOwnPropertyNames(Array.prototype).length;
        const { d, errs } = feedRemoteLins({ r: "__proto__", or: null });
        assert.equal(errs.length, 0, "'__proto__' is a legal string id and must be accepted");
        assert.equal(d.list("seq").size, 1);
        assert.deepEqual(d.list("seq").values(), ["v"]);
        assert.deepEqual(d.list("seq").ids(), ["__proto__#1"]);
        assert.equal(Object.getOwnPropertyNames(Object.prototype).length, protoBefore, "Object.prototype must be untouched");
        assert.equal(Object.getOwnPropertyNames(Array.prototype).length, arrProtoBefore, "Array.prototype must be untouched");
        assert.equal(({}).polluted, undefined);
        d.dispose();
    }
});

test("door: lins or/ol boundary -- null (HEAD) accepted, empty/number/object rejected, bad ol rejected, unresolved-but-valid ol pends", () => {
    { const { d, errs } = feedRemoteLins({ or: null }); assert.equal(errs.length, 0); assert.equal(d.list("seq").size, 1); d.dispose(); }
    for (const bad of ["", 5, {}, [], true]) {
        const { d, errs } = feedRemoteLins({ or: bad, ol: 1 });
        assert.equal(errs.length, 1, "or=" + JSON.stringify(bad) + " must be rejected");
        assert.equal(d.list("seq").size, 0);
        d.dispose();
    }
    for (const badOl of [NaN, Infinity, -Infinity, MAX_LAMPORT, "1", null, undefined, {}]) {
        const { d, errs } = feedRemoteLins({ or: "ghost", ol: badOl });
        assert.equal(errs.length, 1, "ol=" + String(badOl) + " with a valid non-null or must be rejected");
        assert.equal(d.list("seq").size, 0);
        assert.equal(d.list("seq")._retention().pending, 0, "a door-rejected op must never reach the pending buffer");
        d.dispose();
    }
    // A door-VALID or/ol pair whose anchor does not (yet) exist is not a door
    // rejection -- it is held pending, per "out-of-order is PENDING, not dropped".
    {
        const { d, errs } = feedRemoteLins({ or: "ghost", ol: MAX_LAMPORT - 1 });
        assert.equal(errs.length, 0, "a shape-valid but unresolved origin must not be door-rejected");
        assert.equal(d.list("seq").size, 0, "an op pending on an unseen origin must not have integrated");
        assert.equal(d.list("seq")._retention().pending, 1);
        d.dispose();
    }
    // "__proto__" as an origin id is likewise safe (Map-keyed, never a bare
    // object property) -- accepted at the door, held pending because no such
    // anchor exists.
    {
        const { d, errs } = feedRemoteLins({ or: "__proto__", ol: 1 });
        assert.equal(errs.length, 0);
        assert.equal(d.list("seq")._retention().pending, 1);
        d.dispose();
    }
});

test("door: a well-formed ldel and a well-formed lmv both APPLY (C5.2/C5.3) for an unseen birth as placeholders", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    d.list("seq").insert(0, "x");   // birth anchor (l=1, r="R")
    // A door-valid ldel for a birth that does NOT exist here (br="A") is not a
    // rejection -- it records a delete-before-insert placeholder (no error, no
    // visible change to the present element).
    assert.doesNotThrow(() => d.applyOp({ t: "ldel", c: "seq", l: 5, r: "peer", bl: 1, br: "A" }));
    assert.equal(errs.length, 0, "a door-valid ldel is not reported");
    assert.deepEqual(d.list("seq").values(), ["x"], "an ldel for an absent birth must not touch the present element");
    assert.equal(d.list("seq")._retention().pending, 1, "the ldel for an unseen birth is held as a placeholder");
    // A door-valid lmv (C5.3) for an unseen birth (br="A") with a HEAD origin mints
    // its destination anchor UNCONDITIONALLY and records a born-moved placeholder --
    // no error, "x" untouched, one extra anchor and one extra pending slot.
    assert.doesNotThrow(() => d.applyOp({ t: "lmv", c: "seq", l: 6, r: "peer", bl: 1, br: "A", or: null, ol: undefined }));
    assert.equal(errs.length, 0, "a door-valid lmv is not reported");
    assert.deepEqual(d.list("seq").values(), ["x"], "an lmv for an absent birth must not touch the present element");
    assert.equal(d.list("seq")._retention().pending, 2, "the born-moved lmv is held as a placeholder");
    assert.equal(d.list("seq")._retention().anchors, 2, "the lmv minted its destination anchor unconditionally");
    d.dispose();
});

test("door: a well-formed ldel for a PRESENT element applies (deletes it, anchor survives)", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const id = d.list("seq").insert(0, "x");   // "R#1"
    assert.doesNotThrow(() => d.applyOp({ t: "ldel", c: "seq", l: 5, r: "peer", bl: 1, br: "R" }));
    assert.equal(errs.length, 0);
    assert.deepEqual(d.list("seq").values(), [], "the present element is deleted");
    assert.equal(d.list("seq").size, 0);
    assert.equal(d.list("seq").store.length, 0, "proj.length tracks size after a remote delete");
    assert.equal(d.list("seq")._retention().anchors, 1, "the birth anchor survives (still linked) after delete");
    assert.equal(id, "R#1");
    d.dispose();
});

/* === E. Adversarial: pending-origin buffer as an unbounded-growth DoS ==== */

test("adversarial: flooding the pending-origin buffer past PENDING_MAX fails closed (capped, reported, doc stays usable)", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const l = d.list("seq");
    const PENDING_MAX = 4096;
    const FLOOD = PENDING_MAX + 50;
    for (let i = 0; i < FLOOD; i++) {
        // Each op names a distinct, never-arriving origin -- a crafted-frame flood
        // an attacker controlling the wire could mount. The cap is GLOBAL
        // (pendingCount), not per-key, so distinct keys must still be capped.
        assert.doesNotThrow(() => d.applyOp({ t: "lins", c: "seq", l: 1000 + i, r: "attacker" + i, or: "ghost" + i, ol: i, v: "poison" }));
    }
    assert.equal(l.size, 0, "no poisoned insert may have integrated (all origins are fictional)");
    assert.equal(l._retention().pending, PENDING_MAX, "pending must be capped at exactly PENDING_MAX, never above");
    assert.ok(errs.length >= 50, "every overflow op past the cap must be reported to onError");
    // The doc must remain fully usable after the flood: a genuine local insert
    // still applies, and a genuine remote insert at HEAD still applies.
    assert.doesNotThrow(() => l.insert(0, "good-local"));
    assert.equal(l.size, 1);
    const errsBefore = errs.length;
    d.applyOp({ t: "lins", c: "seq", l: 5000, r: "peer", or: null, ol: undefined, v: "good-remote" });
    assert.equal(errs.length, errsBefore, "a genuine well-formed remote insert after the flood must not be rejected");
    assert.equal(l.size, 2);
    d.dispose();
});

test("adversarial: replaying ONE captured orphan frame past PENDING_MAX also fails closed (pending dedup is deferred to drain time, so a single redelivered frame is an equally cheap DoS vector)", () => {
    // Per the measured finding above (pushPending does not dedupe by (l, r) at
    // push time), an attacker does not need distinct crafted frames to exhaust
    // the pending budget -- replaying ONE captured, never-resolved orphan is
    // just as effective, and must be capped identically.
    const errs = [];
    const d = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const l = d.list("seq");
    const PENDING_MAX = 4096;
    const orphan = { t: "lins", c: "seq", l: 7, r: "attacker", or: "ghost", ol: 1, v: "poison" };
    const FLOOD = PENDING_MAX + 50;
    for (let i = 0; i < FLOOD; i++) assert.doesNotThrow(() => d.applyOp(orphan));
    assert.equal(l.size, 0);
    assert.equal(l._retention().pending, PENDING_MAX, "a single redelivered orphan must still be capped at PENDING_MAX, never above");
    assert.ok(errs.length >= 50, "every overflow copy past the cap must be reported");
    assert.doesNotThrow(() => l.insert(0, "still-usable"));
    assert.equal(l.size, 1);
    d.dispose();
});

/* === F. Idempotence under ARBITRARY duplication, at scale ================ */

test("idempotent under arbitrary duplication at scale: shuffled + variably-duplicated redelivery converges to the single-delivery reference", () => {
    const N = 24;
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    const rng = makePrng(0xC0FFEE);
    for (let i = 0; i < N; i++) {
        const idx = rng() % (i + 1); // any legal index into the growing list
        A.list("seq").insert(idx, "e" + i);
    }
    A.dispose();
    assert.equal(log.length, N);

    const ref = createCRDTDoc({ replicaId: "Z" });
    ref.applyOps(log);
    const refValues = ref.list("seq").values();
    const refIds = ref.list("seq").ids();
    const refAnchors = ref.list("seq")._retention().anchors;
    assert.equal(ref.list("seq").size, N);
    ref.dispose();

    // Build a flooded, shuffled delivery: each op duplicated a random 1..4 times,
    // the WHOLE flood shuffled (so duplicates of one op may land anywhere
    // relative to duplicates of another, and relative to still-unseen origins).
    const flooded = [];
    for (const op of log) {
        const copies = 1 + (rng() % 4);
        for (let c = 0; c < copies; c++) flooded.push(op);
    }
    const delivered = shuffle(flooded, rng);

    const dup = createCRDTDoc({ replicaId: "Y" });
    dup.applyOps(delivered);
    assert.deepEqual(dup.list("seq").values(), refValues, "flooded/shuffled duplication diverged in values()");
    assert.deepEqual(dup.list("seq").ids(), refIds, "flooded/shuffled duplication diverged in ids()");
    assert.equal(dup.list("seq").size, N, "duplication must not create phantom elements");
    assert.equal(dup.list("seq")._retention().anchors, refAnchors, "duplication must not create duplicate anchors");
    assert.equal(dup.list("seq").store.length, N, ".store projection length must track size after duplication");

    // Redeliver the ENTIRE flooded log two more times on top of an already-
    // converged replica: still a pure no-op.
    dup.applyOps(delivered);
    dup.applyOps(delivered);
    assert.deepEqual(dup.list("seq").values(), refValues);
    assert.equal(dup.list("seq")._retention().anchors, refAnchors);
    dup.dispose();
});

/* === G. Out-of-order AND duplicate delivery, combined ==================== */

test("an orphan delivered (and re-delivered) before its origin (also re-delivered) converges exactly once (pending dedup is deferred to drain time)", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "a0");
    A.list("seq").insert(1, "a1"); // origin = a0
    A.dispose();
    const [a0, a1] = log;

    const d = createCRDTDoc({ replicaId: "Z" });
    const l = d.list("seq");
    d.applyOp(a1); d.applyOp(a1); d.applyOp(a1); // child arrives 3x before its origin
    assert.equal(l.size, 0);
    // MEASURED: pushPending does not dedupe by (l, r) at push time -- it queues
    // one frozen copy PER delivery, bounded only by PENDING_MAX. Dedup for an
    // orphan happens at DRAIN time, via applyLins's own idempotent nodeAt
    // check: the pending array can (and here does) hold 3 copies of the same
    // still-unintegrated op.
    assert.equal(l._retention().pending, 3, "each pre-origin duplicate delivery queues its own pending copy (dedup is deferred to drain time)");
    d.applyOp(a0); d.applyOp(a0);                // origin arrives 2x: 1st integrates a0 and drains all 3 queued a1 copies (only the first actually integrates; the other two are idempotent no-ops), 2nd is itself an idempotent no-op on the already-integrated a0
    assert.equal(l._retention().pending, 0, "the drain must consume every queued copy, leaving none stranded");
    assert.equal(l.size, 2, "despite 3 queued copies, exactly one a1 element must exist");
    assert.deepEqual(l.values(), ["a0", "a1"]);
    assert.equal(l._retention().anchors, 2, "no duplicate anchors from the 3 queued copies");
    d.applyOp(a1); d.applyOp(a0);                 // both redelivered again post-convergence
    assert.deepEqual(l.values(), ["a0", "a1"]);
    assert.equal(l._retention().anchors, 2);
    d.dispose();
});

/* === H. Re-entrant LOCAL write from a 'change' listener during a drain === */

test("a re-entrant LOCAL insert() from a 'change' listener firing mid-drain converges identically to a sequential control", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "a0");
    A.list("seq").insert(1, "a1"); // origin = a0
    A.dispose();
    const [a0, a1] = log;

    const d = createCRDTDoc({ replicaId: "Z" });
    const l = d.list("seq");
    d.applyOp(a1); // pended: origin a0 unseen

    let fired = false;
    let reentrantOp = null;
    const off = d.on("change", () => {
        if (fired) return;
        fired = true;
        // A genuine LOCAL write, reentrant from inside the change fired by a0's
        // own integration -- BEFORE drainPending(a0) runs. insert() builds its
        // own op (never touches the doc's scratchOp) and must not corrupt the
        // pending drain that is about to happen on the same call stack.
        const before = l.size; // a0 has integrated; a1 has not drained yet
        assert.equal(before, 1, "change must fire after a0 integrates but before a1 drains");
        l.insert(1, "reentrant"); // origin = a0 (index 1 on a size-1 list)
        const opsAfter = log; // unused; ops are captured via the 'op' listener below instead
    });
    const opsOut = [];
    capture(d, opsOut);

    d.applyOp(a0); // integrate a0 -> change fires (reentrant local insert) -> THEN drain a1
    off();

    assert.equal(fired, true);
    assert.equal(l._retention().pending, 0, "the pended a1 must still have drained despite the reentrant local write");
    assert.equal(l.size, 3);
    reentrantOp = opsOut.find((o) => o.v === "reentrant");
    assert.ok(reentrantOp, "the reentrant local insert must have emitted its op");

    // Control: a replica that receives a0, the reentrant op, and a1 in plain
    // sequential (non-reentrant) order must converge to the SAME result --
    // commutativity means the reentrancy must not change the outcome.
    const ctrl = createCRDTDoc({ replicaId: "C" });
    ctrl.applyOp(a0); ctrl.applyOp(reentrantOp); ctrl.applyOp(a1);
    assert.deepEqual(l.values(), ctrl.list("seq").values(), "reentrant-write outcome diverged from the sequential control");
    assert.deepEqual(l.ids(), ctrl.list("seq").ids());

    // And a second control that receives them in the OPPOSITE safe order
    // (a1 after a0, then the reentrant op) must ALSO converge identically,
    // proving the result is order-independent, not an artifact of one path.
    const ctrl2 = createCRDTDoc({ replicaId: "C2" });
    ctrl2.applyOp(a0); ctrl2.applyOp(a1); ctrl2.applyOp(reentrantOp);
    assert.deepEqual(l.values(), ctrl2.list("seq").values());
    assert.deepEqual(l.ids(), ctrl2.list("seq").ids());

    d.dispose(); ctrl.dispose(); ctrl2.dispose();
});

/* === I. .store read-only projection: full mutator sweep + length invariant */

test(".store rejects every array mutator (not just push/splice) and proj.length === size on an EMPTY list too", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    assert.equal(l.store.length, 0, "empty list: store.length must be 0");
    assert.deepEqual(l.values(), []);
    assert.deepEqual(l.ids(), []);

    l.insert(0, "x"); l.insert(1, "y");
    const isRO = (e) => e && e.code === "readonly";
    assert.throws(() => { l.store[0] = "nope"; }, isRO);
    assert.throws(() => { l.store.length = 0; }, isRO, "assigning .length must be blocked too (defineProperty/set trap)");
    assert.throws(() => l.store.push("nope"), isRO);
    assert.throws(() => l.store.pop(), isRO);
    assert.throws(() => l.store.shift(), isRO);
    assert.throws(() => l.store.unshift("nope"), isRO);
    assert.throws(() => l.store.splice(0, 1), isRO);
    assert.throws(() => l.store.sort(), isRO);
    assert.throws(() => l.store.reverse(), isRO);
    assert.throws(() => l.store.fill("z"), isRO);
    assert.throws(() => l.store.copyWithin(0, 1), isRO);
    assert.throws(() => { delete l.store[0]; }, isRO);
    assert.throws(() => Object.defineProperty(l.store, "0", { value: "nope" }), isRO);
    assert.throws(() => Object.setPrototypeOf(l.store, null), TypeError, "setPrototypeOf must be blocked (trap returns false -> throws in strict mode)");

    assert.deepEqual(l.values(), ["x", "y"], "no rejected mutation may have touched state");
    assert.equal(l.store.length, l.size, "proj.length === size after inserts");
    doc.dispose();
});

/* === J. Duplicate dispose + dispose-during-iteration ===================== */

test("duplicate doc.dispose() with a populated list is idempotent and structurally zeroes the list", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const l = doc.list("seq");
    l.insert(0, "x"); l.insert(1, "y");
    assert.equal(l.size, 2);
    assert.doesNotThrow(() => doc.dispose());
    assert.doesNotThrow(() => doc.dispose()); // duplicate dispose: must be a no-op, not a throw
    assert.doesNotThrow(() => doc.dispose()); // and a third time, for good measure
    // The collection object itself survives (JS reference), and its internal
    // structures must have been zeroed by _dispose(), not merely flagged.
    const r = l._retention();
    assert.deepEqual(r, { anchors: 0, elems: 0, pending: 0, unoccupied: 0, reclaimable: 0, justified: 0 }, "list structures must be released, not just doc-flagged");
});

test("dispose-during-iteration: disposing the doc from inside a 'change' listener fired mid drainPending does not crash", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "a0");
    A.list("seq").insert(1, "a1"); // origin = a0
    A.dispose();
    const [a0, a1] = log;

    const d = createCRDTDoc({ replicaId: "Z" });
    const l = d.list("seq");
    d.applyOp(a1); // pended
    assert.equal(l._retention().pending, 1);

    let fired = false;
    d.on("change", () => {
        if (fired) return;
        fired = true;
        d.dispose(); // reentrant dispose, synchronously inside applyLins(a0)'s
                     // ctx.changed(), BEFORE drainPending(a0) runs on the same
                     // call stack -- iterating/mutating pending state on a
                     // just-disposed collection must not throw.
    });

    assert.doesNotThrow(() => d.applyOp(a0), "dispose-during-drain must not throw out of applyOp");
    assert.equal(fired, true);
    // The doc is now disposed; a further dispose must remain idempotent.
    assert.doesNotThrow(() => d.dispose());
    // And the (now-disposed) list's structures read back zeroed, never a stale
    // or partially-torn-down count.
    const r = l._retention();
    assert.equal(r.anchors, 0);
    assert.equal(r.pending, 0);
});
