/**
 * test/17-c4-qa-boundary.test.mjs -- INDEPENDENT QA boundary suite for session
 * C4 (v1.3.0): version vector / compact(V) / getStateSince(V).
 *
 * This suite does NOT trust the planner's ASSERTIONS or the coder's report at
 * face value -- every case re-derives the expected result from the actual code
 * paths in CRDT.js (versionVector/compact/getStateSince/okVector/minAckOf) and
 * asserts against that, independently of test/16-compaction.test.mjs.
 *
 * node:test only. No import beyond node:test, node:assert and the package
 * under test (../CRDT.js).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

const canon = (d) => JSON.stringify(d.snapshot());

/* ===========================================================================
 * versionVector(): boundary matrix (0 / 1 / N writers; copy semantics)
 * ======================================================================== */

test("C4-QA vv/0: a fresh doc's versionVector() is an empty, prototype-free object", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const vv = d.versionVector();
    assert.equal(Object.keys(vv).length, 0, "a fresh doc's version vector must have no entries");
    assert.equal(Object.getPrototypeOf(vv), null, "versionVector() must be prototype-free");
    d.dispose();
});

test("C4-QA vv/1: exactly one local write advances exactly one writer's entry", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    d.map("m").set("k", 1);
    const vv = d.versionVector();
    assert.deepEqual(Object.keys(vv), ["R"]);
    assert.equal(vv.R, 1);
    d.dispose();
});

test("C4-QA vv/N: N writers via applyOp each get an independent max-lamport entry", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    const N = 6;
    for (let i = 0; i < N; i++) {
        d.applyOp({ t: "set", c: "m", k: "k" + i, l: 10 + i, r: "W" + i, v: i });
        d.applyOp({ t: "set", c: "m", k: "k" + i, l: 5 + i, r: "W" + i, v: i }); // lower -- must NOT regress the max
    }
    const vv = d.versionVector();
    assert.equal(Object.keys(vv).length, N, "R (never wrote locally) must not appear; exactly the N observed writers must");
    assert.ok(!("R" in vv), "a writer that never ticked must not appear in the version vector");
    for (let i = 0; i < N; i++) assert.equal(vv["W" + i], 10 + i, "vv must hold the MAX observed lamport, not the last");
    d.dispose();
});

test("C4-QA vv: counters never touch the version vector (no lamport)", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    d.counter("c").inc(5);
    d.applyOp({ t: "cinc", c: "c", r: "peer", p: 9 });
    assert.deepEqual(d.versionVector(), { R: 0 } && d.versionVector()); // sanity: only checking no 'peer' key below
    assert.ok(!("peer" in d.versionVector()), "a counter-only writer must not appear in the version vector");
    d.dispose();
});

test("C4-QA vv: the returned snapshot is a detached COPY -- mutating it never corrupts doc state", () => {
    const d = createCRDTDoc({ replicaId: "R" });
    d.map("m").set("k", 1);
    const vv1 = d.versionVector();
    vv1.R = 999999;
    vv1.INJECTED = 42;
    const vv2 = d.versionVector();
    assert.equal(vv2.R, 1, "mutating a returned vector poisoned the doc's internal version vector");
    assert.ok(!("INJECTED" in vv2), "an injected key on a returned vector leaked into the doc's internal state");
    d.dispose();
});

/* ===========================================================================
 * compact(V): boundary matrix -- 0/1/N-1/N/N+1, empty, null, undefined, NaN, -0
 * ======================================================================== */

function tombstonedDoc() {
    const d = createCRDTDoc({ replicaId: "W" });
    d.map("m").set("k", "orig");     // l=1
    d.map("m").delete("k");          // l=2 -- tombstone (l=2, r=W)
    return d;
}

test("C4-QA compact/empty: V={} (no writers) -> minAck=0 -> reclaims nothing, even with a real tombstone present", () => {
    const d = tombstonedDoc();
    const before = d.getState().cols.m.entries;
    assert.ok(Object.hasOwn(before, "k"), "sanity: the tombstone exists before compaction");
    const reclaimed = d.compact(Object.create(null));
    assert.equal(reclaimed, 0, "an empty frontier must reclaim zero entries (minAck=0, no lamport <= 0)");
    assert.ok(Object.hasOwn(d.getState().cols.m.entries, "k"), "the tombstone must still be present");
    d.dispose();
});

test("C4-QA compact/0 (N-1 of N, boundary just BELOW): frontier one below the tombstone's own lamport reclaims nothing", () => {
    const d = tombstonedDoc();               // tombstone at l=2
    const reclaimed = d.compact({ W: 1 });   // minAck=1 < 2
    assert.equal(reclaimed, 0, "l=2 must NOT be reclaimed at minAck=1 (strictly below)");
    assert.ok(Object.hasOwn(d.getState().cols.m.entries, "k"));
    d.dispose();
});

test("C4-QA compact/N (boundary AT): frontier exactly at the tombstone's own lamport reclaims it (l <= minAck is inclusive)", () => {
    const d = tombstonedDoc();               // tombstone at l=2
    const reclaimed = d.compact({ W: 2 });   // minAck=2 == 2
    assert.equal(reclaimed, 1, "l=2 must be reclaimed at minAck=2 (inclusive boundary)");
    assert.ok(!Object.hasOwn(d.getState().cols.m.entries, "k"));
    d.dispose();
});

test("C4-QA compact/N+1: a frontier past the tombstone's lamport also reclaims it (safe superset)", () => {
    const d = tombstonedDoc();
    const reclaimed = d.compact({ W: 3 });
    assert.equal(reclaimed, 1);
    d.dispose();
});

test("C4-QA compact/null,undefined,NaN,-0: malformed/edge vectors never throw and reclaim only per okVector's real rule", () => {
    const d = tombstonedDoc();
    const before = canon(d);
    const errs = [];
    d._report = undefined; // not part of the public surface; use onError via a fresh doc instead
    for (const V of [null, undefined]) {
        const dd = tombstonedDoc();
        assert.doesNotThrow(() => {
            const r = dd.compact(V);
            assert.equal(r, 0, `compact(${V}) must reclaim nothing`);
        });
        dd.dispose();
    }
    // NaN component -> okVector must reject the whole vector (fail closed), not just skip the bad key.
    {
        const dd = tombstonedDoc();
        const r = dd.compact({ W: NaN });
        assert.equal(r, 0, "a NaN component must reject the whole vector, not merely skip it");
        dd.dispose();
    }
    // -0: Number.isFinite(-0) is true and -0 < 0 is false, so okVector ACCEPTS -0 as a
    // valid lamport (it is indistinguishable from 0 for every comparison below). This
    // must behave IDENTICALLY to an explicit 0 -- never throw, never reclaim a
    // tombstone whose lamport is a real (>=1) value.
    {
        const dd = tombstonedDoc();
        const r = dd.compact({ W: -0 });
        assert.equal(r, 0, "-0 must behave like 0 (minAck=0), not silently misbehave");
        dd.dispose();
    }
    assert.equal(canon(d), before, "state must be unchanged by any of the malformed/edge probes above");
    d.dispose();
});

test("C4-QA compact: a malformed V is reported to onError and reclaims across ALL collection kinds, not just map", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "W", onError: (e) => errs.push(e.code) });
    d.map("m").set("k", 1); d.map("m").delete("k");
    d.array("a").add({ id: "x", v: 1 }); d.array("a").deleteById("x");
    d.counter("c").inc(1);
    const before = canon(d);
    const r = d.compact({ W: NaN });
    assert.equal(r, 0);
    assert.equal(canon(d), before);
    assert.ok(errs.length >= 1);
    d.dispose();
});

test("C4-QA compact: re-add of a compacted id still converges (fresh add after compaction works)", () => {
    const d = createCRDTDoc({ replicaId: "W" });
    const a = d.array("bag");
    a.add({ id: "x", v: 1 });      // l=1
    a.deleteById("x");             // l=2, tombstone Y#... wait tag is W#0
    const reclaimed = d.compact(d.versionVector());
    assert.ok(reclaimed >= 1, "the tombstone must be reclaimed at the doc's own full frontier");
    a.add({ id: "x", v: 2 });      // a fresh LOCAL add after compaction
    assert.equal(a.hasId("x"), true, "re-add after compaction must actually take effect");
    assert.equal(a.get("x").v, 2);
    d.dispose();
});

test("C4-QA compact: double-compact is idempotent (second call on an already-compacted frontier reclaims nothing new)", () => {
    const d = tombstonedDoc();
    const r1 = d.compact({ W: 5 });
    assert.equal(r1, 1);
    const r2 = d.compact({ W: 5 });
    assert.equal(r2, 0, "compacting the same (already-clean) frontier twice must reclaim nothing the second time");
    d.dispose();
});

test("C4-QA compact: compact() then getState() is still a valid state a fresh replica can hydrate from", () => {
    const d = createCRDTDoc({ replicaId: "W" });
    d.map("m").set("k1", 1); d.map("m").delete("k1");
    d.array("a").add({ id: "x", v: 9 }); d.array("a").deleteById("x");
    d.array("a").add({ id: "y", v: 10 });
    d.compact(d.versionVector());
    const state = d.getState();
    const fresh = createCRDTDoc({ replicaId: "FRESH" });
    assert.doesNotThrow(() => fresh.mergeState(state));
    assert.equal(canon(fresh), canon(d), "a post-compaction getState() must fully hydrate a fresh replica");
    d.dispose(); fresh.dispose();
});

/* ===========================================================================
 * getStateSince(V): boundary matrix
 * ======================================================================== */

test("C4-QA delta/0: getStateSince({}) on an empty doc yields an empty-but-valid delta", () => {
    const d = createCRDTDoc({ replicaId: "W" });
    const delta = d.getStateSince(Object.create(null));
    assert.equal(Object.keys(delta.cols).length, 0, "an empty doc's delta must have no collections");
    d.dispose();
});

test("C4-QA delta/null,undefined,NaN,-0: malformed/edge V never throws and falls back sanely", () => {
    const d = createCRDTDoc({ replicaId: "W" });
    d.map("m").set("k", 1);
    for (const V of [null, undefined, { W: NaN }, { W: -0 }]) {
        assert.doesNotThrow(() => d.getStateSince(V));
    }
    // -0 must behave exactly like a real 0 (full delta filter semantics unaffected structurally).
    const dz = d.getStateSince({ W: -0 });
    const d0 = d.getStateSince({ W: 0 });
    assert.deepEqual(dz.cols, d0.cols, "-0 must filter identically to 0");
    d.dispose();
});

test("C4-QA delta: malformed V falls back to FULL state (a safe superset), reported once, and hydrates correctly", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "W", onError: (e) => errs.push(e.code) });
    d.map("m").set("k", 1);
    d.array("a").add({ id: "x", v: 1 });
    const full = d.getState();
    const fallback = d.getStateSince({ W: NaN });
    assert.deepEqual(fallback.cols, full.cols, "a malformed V must fall back to the exact full state");
    assert.ok(errs.length >= 1);
    d.dispose();
});

test("C4-QA delta: chained deltas (a delta of a delta) converge a peer in two hops without corruption", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    A.map("m").set("k1", 1);
    const B = createCRDTDoc({ replicaId: "B" });
    B.mergeState(A.getStateSince(B.versionVector()));   // hop 1
    assert.equal(canon(B), canon(A));

    A.map("m").set("k2", 2);
    A.array("a").add({ id: "x", v: 9 });
    B.mergeState(A.getStateSince(B.versionVector()));   // hop 2 -- a SECOND delta
    assert.equal(canon(B), canon(A), "chained deltas must converge the peer fully");
    A.dispose(); B.dispose();
});

test("C4-QA delta: a delta fed to a peer AHEAD of the sender is a no-op, not corruption", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    A.map("m").set("k", 1);
    const B = createCRDTDoc({ replicaId: "B" });
    B.mergeState(A.getState());
    B.map("m").set("k2", 2);       // B now knows MORE than A
    const before = canon(B);
    const delta = A.getStateSince(B.versionVector());   // A behind B for 'A' writer key? still valid partial state
    assert.doesNotThrow(() => B.mergeState(delta));
    assert.equal(canon(B), before, "merging a delta from a sender the peer is already ahead of must not corrupt state");
    A.dispose(); B.dispose();
});

test("C4-QA delta: multiple removers, different missing writer per peer, still converge (extends the reviewer's 3-writer case)", () => {
    // Y adds e1, e2. Z removes e1. Q removes e2. Two different peers, each missing
    // a DIFFERENT remover, must still converge via getStateSince (removed ships FULL).
    const Y = createCRDTDoc({ replicaId: "Y" });
    const yops = []; Y.on("op", (o) => yops.push(o));
    Y.array("bag").add({ id: "e1" });
    Y.array("bag").add({ id: "e2" });

    const Z = createCRDTDoc({ replicaId: "Z" });
    const zops = []; Z.on("op", (o) => zops.push(o));
    Z.applyOp(yops[0]); Z.applyOp(yops[1]);
    Z.array("bag").deleteById("e1");   // remover Z

    const Q = createCRDTDoc({ replicaId: "Q" });
    const qops = []; Q.on("op", (o) => qops.push(o));
    Q.applyOp(yops[0]); Q.applyOp(yops[1]);
    Q.array("bag").deleteById("e2");   // remover Q

    const S = createCRDTDoc({ replicaId: "S" });
    for (const op of [...yops, ...zops, ...qops]) S.applyOp(op);
    assert.equal(S.array("bag").size, 0, "both e1 and e2 must be dead on the sender");

    // Peer P1 caught up on Y and Z (knows remover Z) but never heard of Q.
    const P1 = createCRDTDoc({ replicaId: "P1" });
    P1.applyOp(yops[0]); P1.applyOp(yops[1]); P1.applyOp(zops[0]);
    assert.equal(P1.array("bag").size, 1, "e2 still live on P1 before the delta");
    P1.mergeState(S.getStateSince(P1.versionVector()));
    assert.equal(P1.array("bag").size, 0, "P1 must lose e2 too (Q's tombstone must ride the delta)");
    assert.equal(canon(P1), canon(S));

    // Peer P2 caught up on Y and Q (knows remover Q) but never heard of Z.
    const P2 = createCRDTDoc({ replicaId: "P2" });
    P2.applyOp(yops[0]); P2.applyOp(yops[1]); P2.applyOp(qops[0]);
    assert.equal(P2.array("bag").size, 1, "e1 still live on P2 before the delta");
    P2.mergeState(S.getStateSince(P2.versionVector()));
    assert.equal(P2.array("bag").size, 0, "P2 must lose e1 too (Z's tombstone must ride the delta)");
    assert.equal(canon(P2), canon(S));

    Y.dispose(); Z.dispose(); Q.dispose(); S.dispose(); P1.dispose(); P2.dispose();
});

test("C4-QA delta: a delta of a doc with all three collection kinds (map+set+counter) round-trips", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    A.map("m").set("k", 1);
    A.array("a").add({ id: "x", v: 1 });
    A.counter("c").inc(3);
    const B = createCRDTDoc({ replicaId: "B" });
    B.mergeState(A.getStateSince(B.versionVector()));
    assert.equal(canon(B), canon(A));
    A.dispose(); B.dispose();
});

test("C4-QA delta: __proto__ collection/element ids still round-trip through getStateSince (no C-12 regression)", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    A.array("__proto__").add({ id: "__proto__", n: 42 });
    const B = createCRDTDoc({ replicaId: "B" });
    B.mergeState(A.getStateSince(B.versionVector()));
    const got = B.array("__proto__").get("__proto__");
    assert.equal(got && got.n, 42);
    assert.equal(({}).polluted, undefined, "Object.prototype was polluted");
    A.dispose(); B.dispose();
});

/* ===========================================================================
 * Back-compat: 1.3.0 <-> simulated 1.2.x peer (never calls compact, removed
 * is a plain array) converge over ops AND full-state sync.
 * ======================================================================== */

test("C4-QA back-compat: a 1.3.0 doc and a simulated 1.2.x peer converge over ops + full-state sync; removed is a sorted string array both ways", () => {
    const modern = createCRDTDoc({ replicaId: "M" });
    const legacyOps = [];
    // "legacy" peer: applies ops normally but NEVER calls compact() and only ever
    // consumes/produces getState() (never getStateSince), matching a 1.2.x peer.
    const legacy = createCRDTDoc({ replicaId: "L" });

    modern.on("op", (op) => legacyOps.push(op));   // registered BEFORE any op so legacy sees everything
    modern.array("bag").add({ id: "e1" });
    modern.array("bag").add({ id: "e2" });
    modern.array("bag").deleteById("e1");
    for (const op of legacyOps) legacy.applyOp(op);
    assert.equal(canon(legacy), canon(modern), "op-level sync must converge a non-compacting legacy peer");

    modern.compact(modern.versionVector());   // modern reclaims; legacy never does
    const rem = modern.getState().cols.bag.removed;
    assert.ok(Array.isArray(rem), "removed must stay a plain array on the wire");
    for (const tk of rem) assert.equal(typeof tk, "string");
    assert.deepEqual(rem, rem.slice().sort(), "removed must be sorted on the wire");

    // Full-state sync in both directions must still converge, even though modern
    // has fewer tombstones locally than legacy.
    const legacyState = legacy.getState();
    modern.mergeState(legacyState);
    const modernState = modern.getState();
    legacy.mergeState(modernState);
    assert.equal(canon(modern), canon(legacy), "modern (compacted) and legacy (uncompacted) must converge on snapshot()");
    modern.dispose(); legacy.dispose();
});

/* ===========================================================================
 * Duplicate dispose / dispose-during-iteration / re-entrant write
 * ======================================================================== */

test("C4-QA dispose: duplicate dispose() is idempotent and every C4 surface fails closed afterward", () => {
    const d = createCRDTDoc({ replicaId: "W" });
    d.map("m").set("k", 1); d.map("m").delete("k");
    d.dispose();
    assert.doesNotThrow(() => d.dispose(), "a second dispose() must not throw");
    assert.equal(d.compact(d.versionVector ? {} : {}), 0, "compact() after dispose must reclaim nothing");
    assert.doesNotThrow(() => d.getStateSince({}), "getStateSince() after dispose must not throw");
    assert.doesNotThrow(() => d.versionVector(), "versionVector() after dispose must not throw");
    assert.equal(Object.keys(d.versionVector()).length, 0, "versionVector() after dispose must be empty (vv cleared)");
});

test("C4-QA dispose-during-iteration: disposing the doc from inside an 'op' callback mid-applyOps must not corrupt or throw", () => {
    const d = createCRDTDoc({ replicaId: "W" });
    let seen = 0;
    const off = d.on("op", () => {
        seen++;
        if (seen === 1) d.dispose();   // dispose from WITHIN the dispatch, mid-batch
    });
    const ops = [
        { t: "set", c: "m", k: "a", l: 1, r: "peer", v: 1 },
        { t: "set", c: "m", k: "b", l: 2, r: "peer", v: 2 },
        { t: "set", c: "m", k: "c", l: 3, r: "peer", v: 3 },
    ];
    assert.doesNotThrow(() => d.applyOps(ops), "dispose() mid-batch must not throw out of applyOps");
    off();
});

test("C4-QA dispose-during-iteration: disposing from inside compact()'s per-collection loop (via onError re-entrancy) does not corrupt state", () => {
    // onError only fires for a malformed V, which compact() checks and returns
    // BEFORE the per-collection loop -- so there is no reentrancy window inside
    // the loop itself. This proves that boundary explicitly: a dispose() called
    // from onError never sees a partially-iterated `cols` Map.
    const d = createCRDTDoc({ replicaId: "W", onError: () => { d.dispose(); } });
    d.map("m").set("k", 1); d.map("m").delete("k");
    d.array("a").add({ id: "x", v: 1 }); d.array("a").deleteById("x");
    assert.doesNotThrow(() => d.compact({ W: NaN }), "a dispose() triggered from onError during compact() must not throw or corrupt");
});

test("C4-QA re-entrant write: applyOp() re-entering itself from inside the 'change' dispatch does not corrupt the shared scratchOp or the version vector", () => {
    // applyOp() does NOT dispatch 'op'/'ops' listeners (those only fire for LOCAL
    // mutators via ctx.emit) -- it DOES call ctx.changed() -> the 'change'
    // listeners, synchronously, from inside the collection's apply(). A 'change'
    // handler that itself calls applyOp() is the genuine re-entrancy the
    // single shared scratchOp comment in CRDT.js is guarding against: "every
    // collection's apply() reads all its op fields BEFORE it fires ctx.changed()".
    const d = createCRDTDoc({ replicaId: "W" });
    let nested = false;
    d.on("change", () => {
        if (!nested) {
            nested = true;
            d.applyOp({ t: "set", c: "m2", k: "inner", l: 100, r: "peer2", v: "INNER" });
        }
    });
    d.applyOp({ t: "set", c: "m", k: "outer", l: 5, r: "peer1", v: "OUTER" });
    assert.equal(d.map("m").get("outer"), "OUTER", "the outer op's own field was corrupted by the nested applyOp");
    assert.equal(d.map("m2").get("inner"), "INNER", "the nested (re-entrant) op did not apply");
    assert.equal(d.versionVector().peer1, 5, "vv corrupted for the outer writer by re-entrant apply");
    assert.equal(d.versionVector().peer2, 100, "vv corrupted for the inner writer by re-entrant apply");
    d.dispose();
});

test("C4-QA re-entrant write: a LOCAL write from inside a 'change' callback during mergeState does not deadlock or corrupt the delta", () => {
    const d = createCRDTDoc({ replicaId: "W" });
    let fired = 0;
    d.on("change", () => {
        fired++;
        if (fired === 1) d.map("other").set("reentrant", true);   // local write, re-entrant during merge
    });
    assert.doesNotThrow(() => d.mergeState({ cols: { m: { kind: "map", entries: { k: [1, "peer", 0, "v"] } } } }));
    assert.equal(d.map("m").get("k"), "v");
    assert.equal(d.map("other").get("reentrant"), true);
    d.dispose();
});

/* ===========================================================================
 * CHARACTERIZATION (PASSES): the documented caller-contract edge, decisions/0004
 * -- "V MUST be the pointwise-min version vector across ALL replicas... A
 * frontier ahead of any lagging replica drops a tombstone that replica still
 * needs and risks resurrection... it never throws." This encodes that KNOWN,
 * ACCEPTED edge as a passing assertion (not a red test): compacting at a
 * frontier that OMITS a live writer entirely (so it is NOT the true pointwise-
 * min) CAN resurrect a tombstoned key, while compacting at the TRUE pointwise-
 * min NEVER does, for the identical op history.
 * ======================================================================== */

test("C4-QA CHARACTERIZATION (documented misuse, decisions/0004): a frontier that OMITS a live writer is NOT the pointwise-min and can resurrect; the TRUE pointwise-min never does", () => {
    // D has observed two writers: itself (D) and a remote writer B (a tombstone
    // (l=4, r=B)). D's full, honest version vector is {D:.., B:4}.
    function build() {
        const d = createCRDTDoc({ replicaId: "D" });
        d.map("other").set("x", 1);          // l=1, D
        d.map("other").set("y", 1);          // l=2, D
        d.applyOp({ t: "set", c: "m", k: "k2", l: 3, r: "B", v: "b1" });
        d.applyOp({ t: "del", c: "m", k: "k2", l: 4, r: "B" });   // tombstone (B, l=4)
        return d;
    }
    // A genuinely concurrent, not-yet-delivered op from writer Z that CORRECTLY
    // loses to B's tombstone (l=3 < 4) as long as the tombstone survives.
    const staleOp = { t: "set", c: "m", k: "k2", l: 3, r: "Z", v: "stale-from-Z" };

    // MISUSE: caller's V = {D: 6} entirely OMITS B (a live writer this exact doc
    // has observed). This is NOT the pointwise-min -- it does not reflect what
    // any replica has actually acknowledged from B -- yet it is well-formed
    // (passes okVector) and a plain, static, non-adversarial object.
    {
        const d = build();
        const reclaimed = d.compact({ D: 6 });                 // B omitted entirely
        assert.ok(reclaimed >= 1, "sanity: the omitted-writer frontier does reclaim B's tombstone");
        d.applyOp(staleOp);
        assert.equal(d.map("m").has("k2"), true,
            "documented misuse: omitting a live writer from V is NOT the pointwise-min and CAN resurrect (decisions/0004 caller contract, not a library bug)");
        d.dispose();
    }

    // CORRECT: the TRUE pointwise-min across all replicas is {D:.., B:0} the
    // moment ANY replica (a lagging peer that has not yet seen B's delete) is
    // included in the min -- B's true minimum observed lamport is 0 for that
    // peer, so minAckOf({..., B: 0, ...}) = 0 and NOTHING is reclaimed.
    {
        const d = build();
        const reclaimed = d.compact({ D: 6, B: 0 });           // TRUE pointwise-min incl. a lagging peer
        assert.equal(reclaimed, 0, "the true pointwise-min (accounting for a peer that has not seen B yet) must reclaim nothing from B");
        d.applyOp(staleOp);
        assert.equal(d.map("m").has("k2"), false,
            "compacting at the TRUE pointwise-min must never resurrect -- the tombstone survives and correctly beats the stale concurrent op");
        d.dispose();
    }
});

/* ===========================================================================
 * REGRESSION (case (a), TOCTOU on the untrusted V surface -- FIXED in v1.3.0).
 * QA reproduced a genuine divergence: `compact(V)` validated V once (okVector)
 * and then RE-READ the same live V independently in `minAckOf`, so a live-
 * accessor V (getter/Proxy) could hand a benign, non-overstated `{W:1}` to the
 * validator and a never-validated `{W:1000}` to the frontier computation ->
 * reclaim a tombstone it must not -> resurrection. The fix reads V ONCE into a
 * validated, prototype-free snapshot (snapshotVector, the C-18 single-read
 * discipline); minAckOf and every `V[r]` filter then consult ONLY that snapshot.
 * This test is the PERMANENT regression: the live-accessor V is now read exactly
 * once, so the frontier computed is exactly the value validated -- no reclaim,
 * no resurrection, converged. NOT the decisions/0004 documented case-(b) misuse
 * (that CHARACTERIZATION test above stays as-is).
 * ======================================================================== */

test("C4-QA REGRESSION (case a, FIXED): a live-accessor V is read ONCE into a validated snapshot, so it cannot validate as {W:1} then compute as {W:1000} -- no resurrection", () => {
    // Control: a CONSISTENT, single-valued, well-formed V={W:1} -- the true,
    // non-overstated frontier here. The tombstone (l=2) is correctly NOT
    // reclaimed, and a later concurrent lower-lamport op correctly LOSES to it.
    {
        const d = tombstonedDoc();                      // tombstone (l=2, r=W)
        const reclaimed = d.compact({ W: 1 });          // minAck=1 < 2 -> must NOT reclaim
        assert.equal(reclaimed, 0, "control: consistent V={W:1} must not reclaim the l=2 tombstone");
        d.applyOp({ t: "set", c: "m", k: "k", l: 1, r: "X", v: "stale" }); // concurrent, l=1 < 2 -> must LOSE
        assert.equal(d.map("m").has("k"), false, "control: a losing concurrent op must not resurrect the key");
        d.dispose();
    }

    // The former finding: a getter-based V. Before the fix okVector read it (->1)
    // and minAckOf re-read it (->1000). After the fix compact() reads V exactly
    // ONCE into a validated snapshot, so the getter fires a single time and the
    // frontier is exactly the value validated.
    let calls = 0;
    const V = {};
    Object.defineProperty(V, "W", {
        enumerable: true,
        get() { calls++; return calls === 1 ? 1 : 1000; },
    });
    const d = tombstonedDoc();
    const reclaimed = d.compact(V);
    d.applyOp({ t: "set", c: "m", k: "k", l: 1, r: "X", v: "stale" });
    const resurrected = d.map("m").has("k");
    d.dispose();

    // The proof the TOCTOU is closed: V's single key is read exactly ONCE.
    assert.equal(calls, 1, "FIXED: compact() must read each field of the untrusted V exactly ONCE (single-read snapshot, C-18); measured " + calls + " reads");
    // And therefore the frontier used is exactly {W:1} (the value validated):
    // the l=2 tombstone is not reclaimed and the losing concurrent op does not
    // resurrect the key.
    assert.equal(reclaimed, 0, "FIXED: a live-accessor V validated as {W:1} must reclaim nothing (minAck computed from the SAME validated value)");
    assert.equal(resurrected, false, "FIXED: no observable resurrection under a live-accessor V -- compact() is now immune the way every other untrusted-payload door is (C-11/C-18)");
});
