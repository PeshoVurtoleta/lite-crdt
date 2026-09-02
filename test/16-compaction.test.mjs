/**
 * C4 -- tombstone compaction + delta sync (v1.3.0, decisions/0004).
 *
 * The proofs the planner's acceptance bar calls out:
 *   (a) CORE convergence-preservation: a doc compacted at a min-frontier V, then
 *       merged with a lagging peer, is byte-identical to an uncompacted control.
 *   (b) mergeState(getStateSince(V)) == getState() for several V, incl. empty V
 *       (= full state) and a V ahead of the doc.
 *   (c) removed/tombstone count bounded by live entries after compact(vv).
 *   (d) valueReg dropped for a stable non-member id, KEPT for an unstable one and
 *       KEPT for a live one.
 *   (e) adversarial: a malformed vector to compact() and a malformed delta to
 *       mergeState() -> onError, no throw, state unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";
import { drive } from "./torture/corpus.mjs";

const canon = (d) => JSON.stringify(d.snapshot());
const canonState = (d) => JSON.stringify(d.getState().cols);

/** Pointwise-min of two version vectors (a missing writer counts as 0). */
function pmin(a, b) {
    const out = Object.create(null);
    for (const k in a) out[k] = Math.min(a[k], typeof b[k] === "number" ? b[k] : 0);
    for (const k in b) if (!(k in out)) out[k] = 0;
    return out;
}

/* ===========================================================================
 * (a) convergence-preservation against a lagging peer
 * ======================================================================== */

test("C4 (a): compacting at a min-frontier stays byte-identical to an uncompacted control after merging a lagging peer", () => {
    for (let seed = 1; seed <= 12; seed++) {
        const log = drive(1234 + seed, { replicas: 3, rounds: 12, opsPerRound: 5 });
        const split = Math.floor(log.length * 0.6);

        // A lagging peer sees only the emission-order prefix (so its vv is a real
        // lower bound per writer -- the prefix preserves per-replica lamport order).
        const P = createCRDTDoc({ replicaId: "P" });
        for (let i = 0; i < split; i++) P.applyOp(log[i]);

        // Control C and compacting D both see the whole log.
        const C = createCRDTDoc({ replicaId: "C" });
        const D = createCRDTDoc({ replicaId: "D" });
        for (const op of log) { C.applyOp(op); D.applyOp(op); }
        assert.equal(canon(D), canon(C), `seed ${seed}: D and C must start identical`);

        // Frontier = what BOTH D and the lagging peer have observed.
        const V = pmin(D.versionVector(), P.versionVector());
        const reclaimed = D.compact(V);
        assert.equal(typeof reclaimed, "number", `seed ${seed}: compact returns a count`);

        // Both exchange full state with the peer; convergence must be preserved.
        const pState = P.getState();
        C.mergeState(pState);
        D.mergeState(pState);
        P.mergeState(C.getState());

        assert.equal(canon(D), canon(C), `seed ${seed}: compacted D diverged from control C`);
        assert.equal(canon(P), canon(C), `seed ${seed}: lagging peer P diverged from control C`);

        C.dispose(); D.dispose(); P.dispose();
    }
});

test("C4 (a2): compaction actually reclaims something on a churn-heavy log (the test is not vacuous)", () => {
    const log = drive(99, { replicas: 3, rounds: 20, opsPerRound: 6 });
    const D = createCRDTDoc({ replicaId: "D" });
    for (const op of log) D.applyOp(op);
    const before = canon(D);
    const reclaimed = D.compact(D.versionVector());   // single system: own vv IS the global min
    assert.ok(reclaimed > 0, "a churn-heavy log must leave causally-stable tombstones to reclaim");
    assert.equal(canon(D), before, "compaction must not change the observable snapshot");
    D.dispose();
});

/* ===========================================================================
 * (b) delta round-trip: mergeState(getStateSince(V)) == getState()
 * ======================================================================== */

test("C4 (b): empty V yields the full state -- mergeState(getStateSince({})) reconstructs the doc", () => {
    const log = drive(7, { replicas: 3, rounds: 10, opsPerRound: 5 });
    const A = createCRDTDoc({ replicaId: "A" });
    for (const op of log) A.applyOp(op);

    const delta = A.getStateSince(Object.create(null));   // empty frontier
    const B = createCRDTDoc({ replicaId: "B" });
    B.mergeState(delta);
    assert.equal(canon(B), canon(A), "delta from empty V must reconstruct the full snapshot");
    assert.equal(canonState(B), canonState(A), "delta from empty V must reconstruct full getState()");
    A.dispose(); B.dispose();
});

test("C4 (b): V = the doc's own vector yields an empty delta -- a replica already at V is unchanged", () => {
    const log = drive(11, { replicas: 3, rounds: 10, opsPerRound: 5 });
    const A = createCRDTDoc({ replicaId: "A" });
    for (const op of log) A.applyOp(op);

    // B is a full copy of A -> already at A's frontier.
    const B = createCRDTDoc({ replicaId: "B" });
    B.mergeState(A.getState());
    const beforeCols = canonState(B);

    const V = A.versionVector();
    const delta = A.getStateSince(V);
    // No register/tag can exceed the doc's own frontier: adds and values are empty.
    for (const name in delta.cols) {
        const cs = delta.cols[name];
        if (cs.kind === "map") assert.equal(Object.keys(cs.entries).length, 0, "map delta beyond own vv must be empty");
        if (cs.kind === "set") {
            assert.equal(Object.keys(cs.adds).length, 0, "set adds delta beyond own vv must be empty");
            assert.equal(Object.keys(cs.values).length, 0, "set values delta beyond own vv must be empty");
        }
    }
    B.mergeState(delta);
    assert.equal(canonState(B), beforeCols, "merging an own-frontier delta into a replica already at V must be a no-op");
    assert.equal(canon(B), canon(A), "snapshot unchanged after the no-op delta");
    A.dispose(); B.dispose();
});

test("C4 (b): a V AHEAD of the doc yields an empty delta", () => {
    const log = drive(23, { replicas: 3, rounds: 8, opsPerRound: 5 });
    const A = createCRDTDoc({ replicaId: "A" });
    for (const op of log) A.applyOp(op);

    const ahead = Object.create(null);
    const vv = A.versionVector();
    for (const k in vv) ahead[k] = vv[k] + 1000;
    const delta = A.getStateSince(ahead);
    for (const name in delta.cols) {
        const cs = delta.cols[name];
        if (cs.kind === "map") assert.equal(Object.keys(cs.entries).length, 0);
        if (cs.kind === "set") {
            assert.equal(Object.keys(cs.adds).length, 0, "set adds delta above the frontier must be empty");
            assert.equal(Object.keys(cs.values).length, 0, "set values delta above the frontier must be empty");
            // removed is DELIBERATELY always full (never filtered by V) -- a tombstone
            // cannot be certified seen from a single peer's vector; extra tombstones are
            // idempotent in the union merge. So it is NOT asserted empty here.
        }
    }
    // Applying it to a full copy leaves it unchanged (idempotent tombstone union).
    const B = createCRDTDoc({ replicaId: "B" });
    B.mergeState(A.getState());
    const before = canonState(B);
    B.mergeState(delta);
    assert.equal(canonState(B), before);
    A.dispose(); B.dispose();
});

test("C4 (b): a partial delta converges a genuinely lagging peer in one frame", () => {
    const log = drive(31, { replicas: 3, rounds: 14, opsPerRound: 5 });
    const split = Math.floor(log.length * 0.5);
    const A = createCRDTDoc({ replicaId: "A" });
    for (const op of log) A.applyOp(op);
    const B = createCRDTDoc({ replicaId: "B" });
    for (let i = 0; i < split; i++) B.applyOp(log[i]);

    // B asks A for everything past B's frontier; one delta must converge it.
    const delta = A.getStateSince(B.versionVector());
    B.mergeState(delta);
    assert.equal(canon(B), canon(A), "one delta frame must converge the lagging peer to the sender");
    A.dispose(); B.dispose();
});

test("C4 (b) REGRESSION: getStateSince ships a tombstone whose remover the peer never heard of (asymmetric per-writer lag)", () => {
    // The bug: getStateSince filtered OR-Set `removed` by the global
    // minAck=min(V.values()), which is meaningless for a single peer's vector. A
    // tombstone's tagKey carries only the ADD-writer, never the REMOVE-writer, so a
    // peer caught up on the add-writer but never told of the remove-writer would
    // silently lose the tombstone from the delta and RESURRECT the element.
    const Y = createCRDTDoc({ replicaId: "Y" });
    const yops = []; Y.on("op", (o) => yops.push(o));
    Y.array("bag").add({ id: "e" });   // op0: add, l=1, tag "Y#0"
    Y.map("m").set("k", 1);            // op1: map set, l=2

    // Z sees ONLY Y's add, then removes e -> the removal lands at lamport 2.
    const Z = createCRDTDoc({ replicaId: "Z" });
    const zops = []; Z.on("op", (o) => zops.push(o));
    Z.applyOp(yops[0]);
    Z.array("bag").deleteById("e");    // rm op, l=2  -> removed["Y#0"] = 2

    // Sender S sees EVERYTHING: e is dead on S.
    const S = createCRDTDoc({ replicaId: "S" });
    S.applyOp(yops[0]); S.applyOp(yops[1]); S.applyOp(zops[0]);
    assert.equal(S.array("bag").size, 0, "e must be dead on the sender");

    // Peer P is caught up on writer Y (vv={Y:2}) but NEVER heard of Z; e is live.
    const P = createCRDTDoc({ replicaId: "P" });
    P.applyOp(yops[0]); P.applyOp(yops[1]);
    const pvv = P.versionVector();
    assert.equal(pvv.Y, 2, "P is caught up on Y at lamport 2");
    assert.ok(!("Z" in pvv), "P is unaware of Z");
    assert.equal(P.array("bag").size, 1, "e is live on the lagging peer before the delta");

    // The exact advertised call. minAck(P.vv) = 2 == the tombstone's rmLamport, so
    // the old `l > minAck` filter dropped it. It must now be carried in FULL.
    const delta = S.getStateSince(P.versionVector());
    assert.ok(delta.cols.bag.removed.includes("Y#0"), "delta MUST carry the tombstone the peer has not seen the remover of");
    P.mergeState(delta);
    assert.equal(P.array("bag").size, 0, "e must be removed on P after the delta -- no resurrection");
    assert.equal(canon(P), canon(S), "peer converges to the sender in one delta frame");
    Y.dispose(); Z.dispose(); S.dispose(); P.dispose();
});

/* ===========================================================================
 * (c) retention bound after compact(vv)
 * ======================================================================== */

test("C4 (c): after compact(vv) the removed/tombstone census is bounded by live entries (control stays unbounded)", () => {
    const ID_COUNT = 8;
    const CYCLES = 500;

    const build = () => {
        const d = createCRDTDoc({ replicaId: "W" });
        const arr = d.array("bag");
        const map = d.map("kv");
        let x = 123456789 >>> 0;
        const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
        for (let i = 0; i < CYCLES; i++) {
            const id = "id" + Math.floor(rnd() * ID_COUNT);
            arr.add({ id, v: i });
            if (rnd() < 0.7) arr.deleteById(id);
            map.set("k" + Math.floor(rnd() * ID_COUNT), i);
            if (rnd() < 0.5) map.delete("k" + Math.floor(rnd() * ID_COUNT));
        }
        return { d, arr, map };
    };

    const control = build();
    const compacted = build();
    const beforeRem = compacted.arr._retention().removed;

    const reclaimed = compacted.d.compact(compacted.d.versionVector());
    assert.ok(reclaimed > 0, "churn must leave stable tombstones to reclaim");

    const after = compacted.arr._retention();
    // Every tombstone was single-writer and <= the current clock, so the whole
    // frontier is stable: removed drops to zero and valueReg keeps only live ids.
    assert.equal(after.removed, 0, "all causally-stable OR tombstones must be reclaimed");
    assert.equal(after.valueReg, compacted.arr.size, "only live members retain a value register after compact");
    assert.ok(after.valueReg <= ID_COUNT, "valueReg bounded by the live id set");

    // The uncompacted control's tombstone census stays O(ops): far larger.
    assert.ok(control.arr._retention().removed > after.removed, "uncompacted control retains more tombstones");
    assert.ok(beforeRem > ID_COUNT, "the pre-compaction census was genuinely unbounded (> live id set)");

    // Observable state is identical to the control across the churn.
    assert.equal(canon(compacted.d), canon(control.d), "compaction preserves the observable snapshot");

    control.d.dispose(); compacted.d.dispose();
});

/* ===========================================================================
 * (d) valueReg: drop stable non-members, keep unstable and live
 * ======================================================================== */

test("C4 (d): compact drops a stable non-member's value register, keeps an unstable one and a live one", () => {
    const d = createCRDTDoc({ replicaId: "W1" });
    const a = d.array("a");
    a.add({ id: "live", v: 1 });    // l=1, stays a member
    a.add({ id: "s", v: 2 });       // l=2
    a.deleteById("s");              // l=3  -> "s" is a stable non-member (register l=2)
    a.add({ id: "u", v: 4 });       // l=4
    a.deleteById("u");              // l=5  -> "u" is a non-member with register l=4

    // Explicit frontier at lamport 3: covers "s" (2) and "live" (1), NOT "u" (4).
    const V = Object.create(null); V["W1"] = 3;
    const reclaimed = d.compact(V);
    // Two things go for 's': its stable removed tombstone AND its stable non-member
    // value register. 'u' (register l=4 > frontier 3) and 'live' (a member) stay.
    assert.equal(reclaimed, 2, "the stable non-member 's' loses both its tombstone and its value register");

    const vals = d.getState().cols.a.values;
    assert.ok(!("s" in vals), "stable non-member 's' value register dropped");
    assert.ok("u" in vals, "unstable non-member 'u' value register KEPT (its write is above the frontier)");
    assert.ok("live" in vals, "live member 'live' value register KEPT even though its write is stable");
    assert.equal(a.get("live").v, 1, "the live member is still readable");
    d.dispose();
});

test("C4 (d2): dropping a stable non-member's register does not change convergence when the id is later re-added higher", () => {
    // Register drop is transparent: a later re-add carries a higher lamport and wins
    // whether or not the old register survived.
    const control = createCRDTDoc({ replicaId: "W" });
    const dropped = createCRDTDoc({ replicaId: "W" });
    for (const doc of [control, dropped]) {
        const a = doc.array("a");
        a.add({ id: "x", v: 1 });     // l=1
        a.deleteById("x");            // l=2 -> stable non-member
    }
    dropped.compact(dropped.versionVector());     // reclaim x's register

    // Both receive the SAME later re-add op (higher lamport, another writer).
    const reAdd = { t: "add", c: "a", id: "x", n: 0, v: { id: "x", v: 999 }, l: 50, r: "W2" };
    control.applyOp(reAdd);
    dropped.applyOp(reAdd);
    assert.equal(canon(dropped), canon(control), "a higher-lamport re-add converges identically after a register drop");
    assert.equal(dropped.array("a").get("x").v, 999, "re-add value wins");
    control.dispose(); dropped.dispose();
});

/* ===========================================================================
 * (e) adversarial: malformed vector / delta -> onError, no throw, unchanged
 * ======================================================================== */

test("C4 (e): a malformed version vector to compact() is reported, reclaims nothing, and throws nothing", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "W", onError: (e) => errs.push(e.code) });
    const a = d.array("a"); a.add({ id: "x", v: 1 }); a.deleteById("x");
    d.map("m").set("k", 1);
    const before = canonState(d);

    const bad = [null, undefined, 42, "nope", true, [], { W: NaN }, { W: Infinity }, { W: -1 }, { W: "5" }, { W: 2 ** 53 }];
    for (const V of bad) {
        assert.doesNotThrow(() => {
            const r = d.compact(V);
            assert.equal(r, 0, "a malformed frontier reclaims nothing");
        }, "compact must never throw on a malformed vector");
    }
    assert.ok(errs.length >= bad.length, "every malformed frontier is reported to onError");
    assert.equal(canonState(d), before, "state unchanged after rejected compaction");
    d.dispose();
});

test("C4 (e): a malformed version vector to getStateSince() fails closed to full state and is reported", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "W", onError: (e) => errs.push(e.code) });
    for (const op of drive(5, { replicas: 2, rounds: 6, opsPerRound: 4 })) d.applyOp(op);

    let delta;
    assert.doesNotThrow(() => { delta = d.getStateSince({ W: NaN }); }, "getStateSince must not throw on a malformed vector");
    assert.ok(errs.length >= 1, "malformed vector reported");
    // Full state is a safe superset: merging it into a fresh doc reconstructs the doc.
    const B = createCRDTDoc({ replicaId: "B" });
    B.mergeState(delta);
    assert.equal(canon(B), canon(d), "a malformed frontier ships full state");
    d.dispose(); B.dispose();
});

test("C4 (e): a malformed delta to mergeState is dropped at the door -- no throw, state unchanged", () => {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "W", onError: (e) => errs.push(e.code) });
    d.map("m").set("k", 1);
    d.array("a").add({ id: "x", v: 1 });
    const before = canon(d);

    // Shaped like a delta (getStateSince output) but with poisoned containers.
    assert.doesNotThrow(() => d.mergeState({ replicaId: "z", clock: 5, cols: { m: { kind: "map", entries: "bad" } } }));
    assert.doesNotThrow(() => d.mergeState({ replicaId: "z", clock: 5, cols: { a: { kind: "set", adds: {}, removed: [], values: null } } }));
    assert.doesNotThrow(() => d.mergeState({ cols: { a: { kind: "set", adds: {}, removed: "notarray", values: {} } } }));
    assert.ok(errs.length >= 1, "malformed delta reported to onError");
    assert.equal(canon(d), before, "state unchanged after rejected deltas");
    d.dispose();
});

/* ===========================================================================
 * back-compat: 1.3.0 <-> 1.2.x wire shape (removed still a lamport-less array)
 * ======================================================================== */

test("C4 back-compat: getState().removed is still a sorted lamport-less array (byte-compatible wire)", () => {
    const d = createCRDTDoc({ replicaId: "W" });
    const a = d.array("a");
    a.add({ id: "x", v: 1 }); a.deleteById("x");
    a.add({ id: "y", v: 2 }); a.deleteById("y");
    const rem = d.getState().cols.a.removed;
    assert.ok(Array.isArray(rem), "removed serializes as an array");
    for (const tk of rem) assert.equal(typeof tk, "string", "each removed entry is a bare tagKey string, no lamport");
    const sorted = rem.slice().sort();
    assert.deepEqual(rem, sorted, "removed is emitted sorted");
    d.dispose();
});

test("C4 back-compat: absorbing a 1.2.x lamport-less removed array is fail-closed (never dropped early)", () => {
    // A 1.2.x peer's state carries removed as a bare array. Absorb it, then compact
    // at a full own frontier: the fail-closed MAX_LAMPORT-1 stamp means those tags
    // are NOT reclaimed (unknown provenance == not-yet-stable).
    const d = createCRDTDoc({ replicaId: "W" });
    d.array("a").add({ id: "keep", v: 1 });   // a live member so the collection exists
    d.mergeState({ cols: { a: { kind: "set", adds: { keep: { "W#0": 1 } }, removed: ["legacy#7", "legacy#9"], values: { keep: [1, "W", 1] } } } });
    const remBefore = d.getState().cols.a.removed;
    assert.ok(remBefore.includes("legacy#7") && remBefore.includes("legacy#9"), "legacy tombstones absorbed");

    const reclaimed = d.compact(d.versionVector());
    const remAfter = d.getState().cols.a.removed;
    assert.ok(remAfter.includes("legacy#7") && remAfter.includes("legacy#9"), "legacy (unknown-provenance) tombstones must NOT be reclaimed early");
    assert.equal(reclaimed, 0, "nothing reclaimable: the only tombstones are fail-closed legacy tags");
    d.dispose();
});
