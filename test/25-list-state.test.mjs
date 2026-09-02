// C5.4 -- RGA list: state serialization + delta + two-tier compaction.
//
// Covers: getState -> mergeState round-trip into a fresh doc (identical
// values()/ids()/_validate + byte-identical re-getState); byte-identical getState
// for two docs converged via different op orders (C2, list kind); mergeState
// re-integrates from ASCENDING origins and does NOT trust a transmitted sibling
// order (scrambled + poison + orphan -> convergence, poison/orphan reported);
// mergeState commutes with live ops (merge-then-log == log-then-merge);
// getStateSince(V) + peer-at-V == full getState() across several frontiers
// (incl. after moves/deletes), malformed V -> full state; compact Tier-1 (a
// causally-stable deleted element's payload reclaimed, anchor survives, sequence
// unchanged); compact Tier-2 ONLY under quiescence (unoccupied anchor unlinks
// when quiesced, is KEPT when a replica lags, and forcing the unlink without
// quiescence LOSES a concurrent insert -- the predicate is load-bearing, RISK #4);
// and a compacted anchor never resurrects on a full-log replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

const MAX_LAMPORT = 2 ** 53;

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
function applyAll(doc, name, ops) { for (const op of ops) doc.applyOp(op); return doc.list(name); }
function seqState(doc) { return JSON.stringify(doc.getState().cols.seq); }

// Build a rich, self-consistent (causally ordered) op log over two writers whose
// origins reference each other's real anchors, exercising insert/move/delete.
function makeLog() {
    const aops = [];
    const A = createCRDTDoc({ replicaId: "A" });
    const offA = A.on("op", (o) => aops.push(o));
    const la = A.list("seq");
    la.insert(0, "x");        // birth (1,A)
    la.insert(1, "y");        // birth (2,A)
    la.insert(2, "z");        // birth (3,A)
    la.move(2, 0);            // z,x,y
    la.insert(3, "w");        // z,x,y,w
    la.delete(1);             // delete x -> z,y,w
    offA();

    const B = createCRDTDoc({ replicaId: "B" });
    for (const o of aops) B.applyOp(o);   // B syncs A causally
    const bops = [];
    const offB = B.on("op", (o) => bops.push(o));
    const lb = B.list("seq");
    lb.insert(0, "b0");       // b0,z,y,w
    lb.move(3, 0);            // move w to front -> w,b0,z,y
    lb.delete(2);             // delete z -> w,b0,y
    offB();

    const full = aops.concat(bops);
    const C = createCRDTDoc({ replicaId: "C" });
    for (const o of full) C.applyOp(o);
    return { full, canonVals: C.list("seq").values(), canonIds: C.list("seq").ids(), canonSeq: seqState(C) };
}

test("getState -> mergeState round-trips into a fresh doc (values/ids/validate + byte-identical re-getState)", () => {
    const { full, canonVals, canonIds } = makeLog();
    const src = createCRDTDoc({ replicaId: "SRC" });
    applyAll(src, "seq", full);

    const dst = createCRDTDoc({ replicaId: "DST" });
    dst.mergeState(src.getState());

    assert.deepEqual(dst.list("seq").values(), canonVals);
    assert.deepEqual(dst.list("seq").ids(), canonIds);
    assert.equal(dst.list("seq")._validate(dst.clock()), true);
    // Byte-identical re-serialization of the list collection.
    assert.equal(seqState(dst), seqState(src));
    // Idempotent: merging the same state again changes nothing.
    dst.mergeState(src.getState());
    assert.deepEqual(dst.list("seq").values(), canonVals);
    assert.equal(seqState(dst), seqState(src));
});

test("getState is byte-identical for two docs converged via different op orders (C2, list kind)", () => {
    const { full, canonSeq } = makeLog();
    const rng = makePrng(0xC5401);
    for (let trial = 0; trial < 12; trial++) {
        const d1 = createCRDTDoc({ replicaId: "P" });
        const d2 = createCRDTDoc({ replicaId: "P" });
        applyAll(d1, "seq", shuffle(full, rng));
        applyAll(d2, "seq", shuffle(full, rng));
        assert.equal(seqState(d1), seqState(d2), "trial " + trial + " diverged");
        assert.equal(seqState(d1), canonSeq, "trial " + trial + " != canonical");
        d1.dispose(); d2.dispose();
    }
});

test("mergeState re-integrates from ascending origins; scrambled+poison+orphan converge, bad pieces reported", () => {
    const { full, canonVals, canonIds } = makeLog();
    const src = createCRDTDoc({ replicaId: "SRC" });
    applyAll(src, "seq", full);
    const good = JSON.parse(seqState(src));

    // Adversarial reshuffle of the node key order + a poison node (non-numeric
    // lamport) + an orphan node (origin that never arrives). mergeState sorts by
    // (l, r) and re-integrates via the same scan, so a scrambled sibling order
    // must NOT change convergence; the poison + orphan must be dropped + reported.
    const revNodes = Object.create(null);
    for (const k of Object.keys(good.nodes).reverse()) revNodes[k] = good.nodes[k];
    revNodes["POISON#notanumber"] = [null, null];          // Number("notanumber") -> NaN -> dropped
    revNodes["orphan#999999"] = ["ghostwriter", 424242];   // origin never present -> orphan dropped
    const adv = { kind: "list", nodes: revNodes, elems: good.elems };

    const errs = [];
    const dst = createCRDTDoc({ replicaId: "DST", onError: (e) => errs.push(e) });
    dst.mergeState({ cols: { seq: adv } });

    assert.deepEqual(dst.list("seq").values(), canonVals);
    assert.deepEqual(dst.list("seq").ids(), canonIds);
    assert.equal(dst.list("seq")._validate(dst.clock()), true);
    assert.ok(errs.length >= 2, "poison + orphan must both be reported (got " + errs.length + ")");
});

test("mergeState commutes with live ops: (merge then log) == (log then merge) == full", () => {
    const { full } = makeLog();
    const ref = createCRDTDoc({ replicaId: "REF" });
    applyAll(ref, "seq", full);
    const refSeq = seqState(ref);

    // merge then replay the whole log
    const m = createCRDTDoc({ replicaId: "M" });
    m.mergeState(ref.getState());
    applyAll(m, "seq", full);

    // replay the whole log then merge
    const n = createCRDTDoc({ replicaId: "N" });
    applyAll(n, "seq", full);
    n.mergeState(ref.getState());

    assert.equal(seqState(m), refSeq, "merge-then-log diverged");
    assert.equal(seqState(n), refSeq, "log-then-merge diverged");
});

test("getStateSince(V) + peer-at-V == full getState() across several frontiers; malformed V -> full", () => {
    const { full } = makeLog();
    const sender = createCRDTDoc({ replicaId: "S" });
    applyAll(sender, "seq", full);
    const fullSeq = seqState(sender);

    // `full` is a causal linearization, so an in-order prefix is causally closed
    // (no pending) -- the correct model of "a peer at frontier V".
    for (const k of [0, 1, 3, 5, 7, full.length - 1, full.length]) {
        const peer = createCRDTDoc({ replicaId: "PEER" });
        applyAll(peer, "seq", full.slice(0, k));
        const V = peer.versionVector();
        peer.mergeState(sender.getStateSince(V));

        // Reference: the same peer hydrated from the FULL state.
        const ref = createCRDTDoc({ replicaId: "REF" });
        applyAll(ref, "seq", full.slice(0, k));
        ref.mergeState(sender.getState());

        assert.equal(seqState(peer), fullSeq, "k=" + k + ": delta-synced peer != full sender");
        assert.equal(seqState(peer), seqState(ref), "k=" + k + ": delta sync != full-state sync");
        assert.deepEqual(peer.list("seq").values(), sender.list("seq").values(), "k=" + k + " values");
        peer.dispose(); ref.dispose();
    }

    // Malformed V fails closed to a full getState() (byte-identical to getState).
    const deltaBad = sender.getStateSince({ S: "not-a-number" });
    assert.equal(JSON.stringify(deltaBad.cols.seq), fullSeq, "malformed V must fall back to full state");
});

test("compact Tier-1: a causally-stable deleted element's payload is reclaimed, anchor survives, sequence unchanged", () => {
    // Single writer A: insert x,y,z; delete y (dl=4, y.ml=2 birth). Control keeps
    // the tombstone; compacting doc reclaims it under a NON-quiescent frontier
    // (a lagging B) so only Tier 1 fires -- the bare anchor must survive.
    const aops = [];
    const A = createCRDTDoc({ replicaId: "A" });
    const off = A.on("op", (o) => aops.push(o));
    const la = A.list("seq");
    la.insert(0, "x"); la.insert(1, "y"); la.insert(2, "z"); la.delete(1);
    off();

    const ctrl = createCRDTDoc({ replicaId: "CTRL" });
    applyAll(ctrl, "seq", aops);
    const comp = createCRDTDoc({ replicaId: "COMP" });
    applyAll(comp, "seq", aops);

    const beforeElems = Object.keys(comp.getState().cols.seq.elems).length;
    const beforeAnchors = comp.list("seq")._retention().anchors;
    assert.equal(beforeElems, 3, "x,y(deleted),z all still have records pre-compact");

    // Non-quiescent frontier: min(V)=4 stabilizes the y delete (Tier 1), but the
    // writers are NOT at a common frontier (max=6 > min=4), so quiesced is false
    // and Tier 2 must not fire -- the bare anchor survives.
    const reclaimed = comp.compact({ A: 4, B: 6 });
    assert.ok(reclaimed >= 1, "Tier-1 must reclaim the stable deleted record");

    const afterElems = Object.keys(comp.getState().cols.seq.elems).length;
    const afterAnchors = comp.list("seq")._retention().anchors;
    assert.equal(afterElems, 2, "the deleted element's serialized record is reclaimed");
    assert.equal(afterAnchors, beforeAnchors, "Tier 1 keeps the bare anchor (Tier 2 did not fire)");
    assert.deepEqual(comp.list("seq").values(), ctrl.list("seq").values(), "sequence unchanged vs control");
    assert.deepEqual(comp.list("seq").ids(), ctrl.list("seq").ids());
    assert.equal(comp.list("seq")._validate(comp.clock()), true);
});

test("compact Tier-2 unlinks an unoccupied anchor ONLY under quiescence", () => {
    // Two concurrent moves of one element mint two anchors; the loser's anchor is
    // abandoned (e=null, born=null) -- an unoccupied, origin-leaf anchor.
    const A = createCRDTDoc({ replicaId: "A" });
    const B = createCRDTDoc({ replicaId: "B" });
    const seed = [];
    const offA = A.on("op", (o) => seed.push(o));
    const la = A.list("seq");
    la.insert(0, "p"); la.insert(1, "q");   // births (1,A),(2,A)
    offA();
    for (const o of seed) B.applyOp(o);

    const mvA = []; const offMvA = A.on("op", (o) => mvA.push(o));
    A.list("seq").move(0, 1);                // A moves p after q
    offMvA();
    const mvB = []; const offMvB = B.on("op", (o) => mvB.push(o));
    B.list("seq").move(0, 1);                // B moves p after q (concurrent)
    offMvB();

    const full = seed.concat(mvA, mvB);
    const conv = createCRDTDoc({ replicaId: "CONV" });
    applyAll(conv, "seq", full);
    const anchorsAll = conv.list("seq")._retention().anchors;
    assert.equal(anchorsAll, 4, "2 births + 2 minted move anchors (one abandoned)");
    const convVals = conv.list("seq").values();

    // Quiescence TRUE: every writer acked up to the clock. The abandoned anchor
    // (unoccupied, origin-leaf) unlinks -> anchors drops. Sequence unchanged.
    const compQ = createCRDTDoc({ replicaId: "Q" });
    applyAll(compQ, "seq", full);
    const clk = compQ.clock();
    compQ.compact({ A: clk, B: clk });
    assert.ok(compQ.list("seq")._retention().anchors < anchorsAll, "Tier 2 must unlink the abandoned anchor under quiescence");
    assert.deepEqual(compQ.list("seq").values(), convVals, "Tier 2 must not change the visible sequence");
    assert.equal(compQ.list("seq")._validate(compQ.clock()), true);

    // A lagging replica (B far behind) => quiesced false => Tier 2 must NOT unlink.
    const compL = createCRDTDoc({ replicaId: "L" });
    applyAll(compL, "seq", full);
    compL.compact({ A: clk, B: 1 });
    assert.equal(compL.list("seq")._retention().anchors, anchorsAll, "Tier 2 must not unlink when a replica lags");
    assert.deepEqual(compL.list("seq").values(), convVals);
});

test("Tier-2 quiescence predicate is load-bearing: forcing the unlink loses a concurrent insert", () => {
    // R1 inserts "a" (birth (1,R1)) then deletes it. R2 -- which saw only "a",
    // NOT the delete -- concurrently inserts "b" after "a" (origin (1,R1)).
    const aops = [];
    const R1seed = createCRDTDoc({ replicaId: "R1" });
    const off = R1seed.on("op", (o) => aops.push(o));
    R1seed.list("seq").insert(0, "a");        // (1,R1)
    off();
    const opAlins = aops[0];

    const R2 = createCRDTDoc({ replicaId: "R2" });
    R2.applyOp(opAlins);                       // R2 sees "a" only
    const bops = []; const offB = R2.on("op", (o) => bops.push(o));
    R2.list("seq").insert(1, "b");             // origin (1,R1)
    offB();
    const opB = bops[0];

    function makeReclaimed() {
        const d = createCRDTDoc({ replicaId: "R1" });
        const l = d.list("seq");
        l.insert(0, "a");                      // (1,R1)
        l.delete(0);                           // dl=2, ml=1
        return { d, l };
    }

    // BUGGY path: force Tier 2 (quiesced=true) though R2 has NOT acked -- the
    // anchor (1,R1) is unlinked, so R2's concurrent insert-b orphans (origin gone)
    // and "b" is LOST: the resurrection/loss the predicate exists to prevent.
    const bug = makeReclaimed();
    bug.l._compact(2, true);                    // Tier 1 reclaims "a", Tier 2 unlinks the bare anchor
    bug.d.applyOp(opB);
    assert.equal(bug.l.values().includes("b"), false, "forcing Tier 2 without quiescence loses the concurrent insert");
    assert.equal(bug.l._retention().pending, 1, "insert-b is stranded in the pending buffer (origin gone)");
    bug.d.dispose();

    // CORRECT path: quiesced=false keeps the bare anchor; insert-b lands.
    const ok = makeReclaimed();
    ok.l._compact(2, false);                    // Tier 1 only; anchor kept
    ok.d.applyOp(opB);
    assert.deepEqual(ok.l.values(), ["b"], "with the anchor kept, the concurrent insert converges");
    assert.equal(ok.l._retention().pending, 0);
    assert.equal(ok.l._validate(ok.d.clock()), true);
    ok.d.dispose();
});

test("a compacted anchor never resurrects: replaying the full log post-compaction leaves the sequence unchanged", () => {
    const { full } = makeLog();
    const comp = createCRDTDoc({ replicaId: "COMP" });
    applyAll(comp, "seq", full);

    // Quiescent compaction (both writers acked up to the clock): Tier 1 + Tier 2.
    const clk = comp.clock();
    comp.compact({ A: clk, B: clk });
    const afterVals = comp.list("seq").values();
    const afterIds = comp.list("seq").ids();
    assert.equal(comp.list("seq")._validate(comp.clock()), true);

    // Replay the ENTIRE op log again: a compacted (deleted) anchor may be briefly
    // recreated by its lins, but its ldel is in the log too and re-deletes it, so
    // the converged visible sequence is unchanged. No live element resurrects.
    applyAll(comp, "seq", full);
    assert.deepEqual(comp.list("seq").values(), afterVals, "replay after compaction changed the sequence");
    assert.deepEqual(comp.list("seq").ids(), afterIds);
    assert.equal(comp.list("seq")._validate(comp.clock()), true);
});

test("SECURITY: crafted mergeState keyed by an OCCUPIED move-anchor id must not evict the live occupant", () => {
    // Reviewer repro: E moved onto move anchor (2,R); its birth (1,R) is vacated.
    // A crafted state keys `elems` by the OCCUPIED move-anchor id "R#2" -- adopting
    // that node as a fresh element's home would clobber `birthNode.e` and silently
    // evict E. The door must fail closed (report malformed_state, no eviction).
    const errs = [];
    const R = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const l = R.list("seq");
    l.insert(0, "E");   // birth (1,R)
    l.move(0, 0);       // E now occupies move anchor (2,R); birth (1,R) vacated
    const beforeVals = l.values(), beforeIds = l.ids();

    R.mergeState({ cols: { seq: { kind: "list",
        nodes: { "R#1": [null, null], "R#2": [null, null] },
        elems: { "R#2": [2, "R", "R#2", 0, 0, "", "HIJACK"] } } } });

    assert.deepEqual(l.values(), beforeVals, "the live element E must NOT be evicted");
    assert.deepEqual(l.ids(), beforeIds, "E's identity must be unchanged");
    assert.equal(l.values().includes("HIJACK"), false, "the crafted value must not appear");
    assert.ok(errs.some((e) => e.code === "malformed_state"), "the crafted piece must be reported as malformed_state");
    assert.equal(l._validate(R.clock()), true);
    R.dispose();
});

test("SECURITY: crafted mergeState element claiming another live element's display anchor must not evict it", () => {
    // Two live elements A (birth (1,R)) and B (birth (2,R)), neither moved. A crafted
    // element for A with a WINNING register stamp claims B's display anchor "R#2":
    // the relink would evict B. The door must fail closed at the relink guard.
    const errs = [];
    const R = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const l = R.list("seq");
    l.insert(0, "A");   // birth (1,R), display anchor R#1
    l.insert(1, "B");   // birth (2,R), display anchor R#2
    const beforeVals = l.values(), beforeIds = l.ids();

    R.mergeState({ cols: { seq: { kind: "list",
        nodes: { "R#1": [null, null], "R#2": ["R", 1] },
        // A's register jumps to (5,R) and claims B's occupied display anchor R#2.
        elems: { "R#1": [5, "R", "R#2", 0, 0, "", "A"] } } } });

    assert.deepEqual(l.values(), beforeVals, "B must NOT be evicted by A's crafted relink");
    assert.deepEqual(l.ids(), beforeIds);
    assert.ok(errs.some((e) => e.code === "malformed_state"), "the crafted relink must be reported as malformed_state");
    assert.equal(l._validate(R.clock()), true);
    R.dispose();
});
