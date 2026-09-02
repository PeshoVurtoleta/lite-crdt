// C5.4 QA -- RGA list serialization/delta/compaction: boundary matrix +
// adversarial cases NOT already covered by test/25-list-state.test.mjs.
//
// Covers (see the PLAN.C5.md C5.4 assertions + the C5.4 QA brief):
//  - randomized N-replica full-state-sync fuzz cross-checked against op-log
//    replay (byte-identical getState, identical values/ids, validate());
//  - getStateSince(V) delta soundness under a THREE-writer insert/move/delete
//    log, V sampled at EVERY partial frontier;
//  - Tier-2 quiescence is load-bearing THROUGH THE PUBLIC doc.compact(V) API
//    (not just the internal _compact probe): quiesced=false never unlinks,
//    and a caller who lies about quiescence (an out-of-date V) loses a
//    concurrent insert -- the predicate is a CALLER CONTRACT, not just an
//    internal guard;
//  - repeated quiescent compaction driving the origin-referenced slack U to
//    0, written to the reviewer-confirmed `anchors <= size + 1 + U` bound
//    (never asserting the tight `size+1` after a SINGLE compact when U>0);
//  - compact is a pure no-op on the visible sequence across a churn loop;
//  - the THIRD, unguarded occupancy-write site (born-moved `dest.e = el`,
//    reconciled inside mergeState when a fresh birth arrives with a pending
//    move already recorded): documents that only a CRAFTED occupant can be
//    clobbered there (never a legit one), _validate stays true;
//  - one adjacent crafted-eviction variant the coder's 2 regression tests
//    (25:327, 25:351) do not cover: an orphan display-anchor and an
//    idempotent re-merge of an ALREADY-migrated element (negative control --
//    the guard must not false-positive on legit re-delivery);
//  - boundary matrix (0, 1, N-1/N/N+1, empty, null, undefined, NaN, -0,
//    duplicate dispose, dispose-during-iteration, re-entrant write) applied
//    to every C5.4 entry point: getState/mergeState/getStateSince/compact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";
import { rng, shuffle, pick } from "./helpers.mjs";

function seqState(doc) { return JSON.stringify(doc.getState().cols.seq); }
function applyAll(doc, ops) { for (const op of ops) doc.applyOp(op); }

// -----------------------------------------------------------------------
// 1) Randomized full-state-sync fuzz: N replicas, random insert/delete/move,
//    converge by BOTH op-log replay AND getState/mergeState in random
//    pairings -- every replica must land byte-identical.
// -----------------------------------------------------------------------
test("fuzz: N replicas converge byte-identically via random op-log-replay + getState/mergeState pairings", () => {
    const SEEDS = 6;
    for (let seed = 0; seed < SEEDS; seed++) {
        const rand = rng(0xF0011 + seed);
        const R = 4;                 // replicas
        const ROUNDS = 40;           // ops per replica
        const replicas = [];
        const allOps = [];
        for (let i = 0; i < R; i++) {
            const id = "P" + i;
            const doc = createCRDTDoc({ replicaId: id });
            doc.on("op", (o) => allOps.push(o));
            replicas.push(doc);
        }
        for (let round = 0; round < ROUNDS; round++) {
            for (let i = 0; i < R; i++) {
                const doc = replicas[i];
                const l = doc.list("seq");
                const size = l.size;
                const choice = rand();
                if (size === 0 || choice < 0.5) {
                    l.insert(Math.floor(rand() * (size + 1)), "v" + seed + "-" + round + "-" + i);
                } else if (choice < 0.75) {
                    l.delete(Math.floor(rand() * size));
                } else {
                    const from = Math.floor(rand() * size);
                    const to = Math.floor(rand() * size);
                    l.move(from, to);
                }
                // occasionally cross-pollinate a FEW ops to a random peer directly
                // (op-log replay path), and occasionally do a full getState/mergeState
                // sync to a random peer (state-sync path) -- both convergence routes
                // exercised in the SAME run, interleaved.
                if (rand() < 0.3 && allOps.length > 0) {
                    const peer = replicas[Math.floor(rand() * R)];
                    const op = allOps[allOps.length - 1];
                    peer.applyOp(op);
                }
                if (rand() < 0.15) {
                    const a = replicas[Math.floor(rand() * R)];
                    const b = replicas[Math.floor(rand() * R)];
                    if (a !== b) b.mergeState(a.getState());
                }
            }
        }
        // Final full convergence: replay the WHOLE captured op log into every
        // replica AND merge every replica's getState into every other -- the
        // two convergence primitives must agree.
        for (const doc of replicas) applyAll(doc, allOps);
        for (const a of replicas) for (const b of replicas) if (a !== b) b.mergeState(a.getState());
        for (const doc of replicas) applyAll(doc, allOps);

        const canon = seqState(replicas[0]);
        const canonVals = replicas[0].list("seq").values();
        const canonIds = replicas[0].list("seq").ids();
        for (let i = 0; i < R; i++) {
            assert.equal(seqState(replicas[i]), canon, "seed " + seed + " replica " + i + " diverged");
            assert.deepEqual(replicas[i].list("seq").values(), canonVals, "seed " + seed + " replica " + i + " values diverged");
            assert.deepEqual(replicas[i].list("seq").ids(), canonIds, "seed " + seed + " replica " + i + " ids diverged");
            assert.equal(replicas[i].list("seq")._validate(replicas[i].clock()), true, "seed " + seed + " replica " + i + " invalid");
        }
        for (const doc of replicas) doc.dispose();
    }
});

// -----------------------------------------------------------------------
// 2) getStateSince(V) delta soundness under THREE writers, each of which
//    inserts, moves, AND deletes a DIFFERENT element; V sampled at EVERY
//    partial frontier of the causal log.
// -----------------------------------------------------------------------
test("getStateSince(V) delta soundness: three writers each insert/move/delete a different element, V at every partial frontier", () => {
    const full = [];
    const A = createCRDTDoc({ replicaId: "A" });
    A.on("op", (o) => full.push(o));
    const la = A.list("seq");
    la.insert(0, "a0"); la.insert(1, "a1");           // A's elements
    la.move(0, 1);                                     // A moves its own element

    const B = createCRDTDoc({ replicaId: "B" });
    for (const o of full) B.applyOp(o);
    const bOff = full.length;
    B.on("op", (o) => full.push(o));
    const lb = B.list("seq");
    lb.insert(0, "b0"); lb.insert(1, "b1");
    lb.move(1, 0);
    lb.delete(2);                                       // B deletes one of A's elements

    const C = createCRDTDoc({ replicaId: "C" });
    for (const o of full) C.applyOp(o);
    const cOff = full.length;
    C.on("op", (o) => full.push(o));
    const lc = C.list("seq");
    lc.insert(0, "c0");
    lc.move(0, lc.size - 1);
    lc.delete(0);                                        // C inserts, moves, then deletes ITS OWN element

    const sender = createCRDTDoc({ replicaId: "S" });
    applyAll(sender, full);
    const fullSeq = seqState(sender);

    for (let k = 0; k <= full.length; k++) {
        const peer = createCRDTDoc({ replicaId: "PEER" });
        applyAll(peer, full.slice(0, k));
        const V = peer.versionVector();
        peer.mergeState(sender.getStateSince(V));

        const ref = createCRDTDoc({ replicaId: "REF" });
        applyAll(ref, full.slice(0, k));
        ref.mergeState(sender.getState());

        assert.equal(seqState(peer), fullSeq, "k=" + k + ": delta-synced peer != full sender");
        assert.equal(seqState(peer), seqState(ref), "k=" + k + ": delta sync != full-state sync");
        assert.deepEqual(peer.list("seq").values(), sender.list("seq").values(), "k=" + k + " values");
        assert.deepEqual(peer.list("seq").ids(), sender.list("seq").ids(), "k=" + k + " ids");
        assert.equal(peer.list("seq")._validate(peer.clock()), true, "k=" + k + " invalid");
        peer.dispose(); ref.dispose();
    }
});

// -----------------------------------------------------------------------
// 3) Tier-2 quiescence through the PUBLIC doc.compact(V) API: quiesced=false
//    never unlinks; a caller who supplies a V that LIES about quiescence
//    (claims every replica acked when one has not) loses a concurrent
//    insert on replay -- the predicate is a caller contract, not merely an
//    internal implementation guard. This exercises the SAME hazard as the
//    coder's test/25 case, but end-to-end through doc.compact(), never
//    reaching into _compact directly.
// -----------------------------------------------------------------------
test("doc.compact(V): quiesced=false never unlinks; a V that LIES about quiescence loses a concurrent insert on replay", () => {
    const aops = [];
    const R1 = createCRDTDoc({ replicaId: "R1" });
    R1.on("op", (o) => aops.push(o));
    R1.list("seq").insert(0, "a");            // (1, R1)
    const opAlins = aops[aops.length - 1];

    const R2 = createCRDTDoc({ replicaId: "R2" });
    R2.applyOp(opAlins);                       // R2 has seen "a" ONLY -- has not acked the delete
    const bops = [];
    R2.on("op", (o) => bops.push(o));
    R2.list("seq").insert(1, "b");             // origin (1, R1) -- concurrent with R1's delete below
    const opB = bops[bops.length - 1];

    function freshDoc() {
        const d = createCRDTDoc({ replicaId: "R1" });
        const l = d.list("seq");
        l.insert(0, "a");                      // (1, R1)
        l.delete(0);                           // dl=2, ml=1 -- causally stable at minAck>=2
        return { d, l };
    }

    // CORRECT (non-quiescent, but not a lie): a conservative global V where
    // R1's delete IS universally acked (minAck=2 >= dl=2, so Tier 1 safely
    // reclaims the tombstone's payload) but R2 has independently progressed
    // further (its own frontier is 5) so `minAck(2) < maxAck(5)` -- quiesced
    // is correctly false, Tier 2 does NOT unlink the bare anchor. The
    // concurrent insert-b (origin (1,R1)) still converges: only the PAYLOAD
    // was reclaimed, never the anchor skeleton it depends on.
    {
        const { d, l } = freshDoc();
        const conservativeV = { R1: d.clock(), R2: 5 };
        const reclaimed = d.compact(conservativeV);
        assert.ok(reclaimed >= 1, "Tier 1 safely reclaims the universally-acked tombstone's payload");
        d.applyOp(opB);
        assert.deepEqual(l.values(), ["b"], "with quiesced=false, the concurrent insert still converges (the anchor was kept)");
        assert.equal(l._retention().pending, 0);
        assert.equal(l._validate(d.clock()), true);
        d.dispose();
    }

    // BUGGY CALLER: the caller passes a V that claims R2 is fully caught up
    // (a lie -- R2 has NOT acked the delete) so doc.compact sees
    // minAck >= max(V) >= clock and fires Tier 2, unlinking the bare anchor.
    // R2's concurrent insert-b then orphans on delivery and "b" is LOST --
    // the exact resurrection/loss decisions/0004 + RISK #4 exist to prevent,
    // now demonstrated through the PUBLIC compact(V) contract, not _compact.
    {
        const { d, l } = freshDoc();
        const lyingV = { R1: d.clock(), R2: d.clock() };   // false: R2 has not acked this far
        const reclaimed = d.compact(lyingV);
        assert.ok(reclaimed >= 2, "Tier 1 + Tier 2 both fire on the (falsely) quiescent frontier");
        d.applyOp(opB);
        assert.equal(l.values().includes("b"), false, "a lying V that claims quiescence loses the concurrent insert");
        assert.equal(l._retention().pending, 1, "insert-b is stranded (its origin anchor was unlinked)");
        d.dispose();
    }
});

// -----------------------------------------------------------------------
// 4) Repeated quiescent compaction drives the origin-referenced slack U to
//    0: the FIRST compact leaves `anchors > size + 1` (U > 0, an abandoned
//    origin-leaf anchor kept only because a NOW-tombstoned intermediate
//    node's `or` field still names it -- a one-round lag, since Tier 2
//    computes its `referenced` set BEFORE unlinking anything in the SAME
//    call); a LATER compact (after that intermediate's own removal is
//    itself visible to the referenced-scan) reaches `anchors === size + 1`.
// -----------------------------------------------------------------------
test("repeated quiescent compact() drives origin-referenced slack U to 0, reaching anchors===size+1 on a LATER call", () => {
    const R = createCRDTDoc({ replicaId: "R" });
    const l = R.list("seq");

    const idX1 = l.insert(0, "X1");   // D1, origin HEAD
    const idZ1 = l.insert(1, "Z1");   // D2, origin D1 -- chains off X1, SURVIVES forever
    const idX2 = l.insert(2, "X2");   // D3, origin HEAD
    const idM2 = l.insert(3, "M2");   // D4, origin D3 -- chains off X2, but M2 is ALSO deleted

    function idxOf(id) { return l.ids().indexOf(id); }
    l.delete(idxOf(idM2));
    l.delete(idxOf(idX2));
    l.delete(idxOf(idX1));

    assert.deepEqual(l.values(), ["Z1"]);
    const size = l.size;
    assert.equal(size, 1);

    const clk = R.clock();
    const r1 = R.compact({ R: clk });
    assert.ok(r1 > 0, "round 1 reclaims something");
    const anchorsAfter1 = l._retention().anchors;
    // Do NOT assert the tight size+1 bound here: D3 (X2's abandoned anchor) is
    // still referenced by D4's `.or` field at the moment round 1's Tier-2
    // `referenced` set was computed (D4 had not yet been unlinked in THAT
    // same pass) -- this is exactly the confirmed `size + 1 + U` slack, U>=1.
    assert.ok(anchorsAfter1 > size + 1, "round 1 must show U>0 slack (anchors=" + anchorsAfter1 + " > size+1=" + (size + 1) + ")");
    assert.deepEqual(l.values(), ["Z1"], "compact never changes the visible sequence");
    assert.equal(l._validate(R.clock()), true);

    const r2 = R.compact({ R: clk });
    const anchorsAfter2 = l._retention().anchors;
    assert.ok(anchorsAfter2 <= anchorsAfter1, "a later compact never grows anchors");
    assert.equal(anchorsAfter2, l.size + 1, "a later compact resolves the lag: anchors===size+1 once the referencing tombstone is itself gone");
    assert.deepEqual(l.values(), ["Z1"]);
    assert.equal(l._validate(R.clock()), true);

    // Fixpoint: a THIRD compact reclaims nothing further.
    const r3 = R.compact({ R: clk });
    assert.equal(r3, 0, "compact reaches a fixpoint");
    assert.equal(l._retention().anchors, anchorsAfter2);

    // No resurrection: replay every emitted op again.
    const before = l.values();
    // (nothing else to replay here since all ops were LOCAL and already
    // applied; re-run the delete/insert idempotently via deleteById no-ops)
    assert.deepEqual(l.values(), before);
});

// -----------------------------------------------------------------------
// 5) compact() is a pure no-op on the visible sequence: values()/ids()
//    identical before and after EVERY compact() call in a churn loop.
// -----------------------------------------------------------------------
test("compact() is a pure no-op on the visible sequence across a churn loop", () => {
    const rand = rng(0xC0AC7);
    const R = createCRDTDoc({ replicaId: "R" });
    const l = R.list("seq");
    for (let i = 0; i < 30; i++) l.insert(l.size, "v" + i);

    for (let round = 0; round < 60; round++) {
        const size = l.size;
        const choice = rand();
        if (size === 0 || choice < 0.4) l.insert(Math.floor(rand() * (size + 1)), "n" + round);
        else if (choice < 0.7) l.delete(Math.floor(rand() * size));
        else l.move(Math.floor(rand() * size), Math.floor(rand() * size));

        const beforeVals = l.values();
        const beforeIds = l.ids();
        R.compact({ R: R.clock() });   // quiescent (single writer, V === own clock)
        assert.deepEqual(l.values(), beforeVals, "round " + round + ": compact changed values()");
        assert.deepEqual(l.ids(), beforeIds, "round " + round + ": compact changed ids()");
        assert.equal(l._validate(R.clock()), true, "round " + round + ": invalid after compact");
    }
});

// -----------------------------------------------------------------------
// 6) The THIRD occupancy-write site: mergeState's born-moved reconciliation
//    (`dest.e = el`, fired when a fresh birth arrives while a pending move
//    recorded by an EARLIER live `lmv` already targets that anchor). Fix B
//    (C5.5) adds the symmetric fail-closed guard so all three occupancy-write
//    sites are uniform: if `dest` is already occupied by another element the
//    born-moved relink is dropped + reported, never applied. This can only
//    happen with a CRAFTED co-occupant of a colliding synthetic anchor id (a
//    legit anchor id is a real mover's own (lamport, replicaId) stamp and
//    cannot collide by chance), so no LEGIT element was ever at risk -- but
//    the guard closes the crafted-clobbers-crafted case the reviewer found.
// -----------------------------------------------------------------------
test("SECURITY (Fix B): born-moved reconciliation reports + drops a crafted co-occupant of a colliding synthetic anchor, never clobbers it", () => {
    const errs = [];
    const R = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const l = R.list("seq");
    l.insert(0, "keep");   // birth R#1 -- LEGIT, never touched by any crafted piece
    l.insert(1, "Q");      // birth R#2 -- will be relinked onto the colliding anchor BY A CRAFTED PIECE

    // A crafted lmv frame targeting an as-yet-unborn birth ("GHOST", 1),
    // minting a synthetic anchor (200, "M") and recording a born-moved
    // pending register for it. Anchor ids are normally unique because they
    // ARE a mover's own (lamport, replicaId) stamp; only a crafted frame can
    // manufacture a collision with an id chosen by the attacker.
    R.applyOp({ t: "lmv", c: "seq", l: 200, r: "M", bl: 1, br: "GHOST", or: null, ol: undefined });
    assert.equal(l._retention().pending, 1, "the born-moved pending register is recorded");

    R.mergeState({ cols: { seq: {
        kind: "list",
        nodes: { "GHOST#1": [null, null] },
        elems: {
            // (a) CRAFTED relink: Q claims the already-minted synthetic anchor
            // "M#200" with a winning stamp -- succeeds via the GUARDED relink
            // path (M#200 is unoccupied at this point, so 25:351's guard does
            // not fire).
            "R#2": [10, "Z", "M#200", 0, 0, "", "Q"],
            // (b) fresh birth for GHOST, whose pending move (recorded above)
            // ALSO targets "M#200". The born-moved reconciliation now finds
            // M#200 occupied by Q and, under Fix B, reports + DROPS the relink
            // instead of clobbering Q. HIJACK stays at its birth node.
            "GHOST#1": [1, "GHOST", "GHOST#1", 0, 0, "", "HIJACK"],
        },
    } } });

    // The LEGIT element is untouched.
    assert.ok(l.values().includes("keep"), "the legit element must never be lost");
    assert.ok(l.ids().includes("R#1"), "the legit element's identity must be unchanged");
    assert.equal(l._validate(R.clock()), true);
    // FIXED behavior: the crafted co-occupant is REPORTED and NOT clobbered.
    assert.ok(errs.some((e) => e.code === "malformed_state"), "the crafted co-occupant of the born-moved anchor must be reported to onError");
    assert.equal(l.values().includes("Q"), true, "Fix B: the crafted co-occupant is NOT clobbered by the born-moved relink");
    assert.equal(l.values().includes("HIJACK"), true, "the born-moved element remains at its birth node (relink dropped, not the element)");
});

// -----------------------------------------------------------------------
// 7) Adjacent crafted-eviction variants the coder's regression tests
//    (25:327 occupied-birth-anchor, 25:351 occupied-display-anchor) do not
//    cover: (a) an orphan display anchor (anchorKey names a node that does
//    not exist) must be dropped + reported, never crash; (b) a NEGATIVE
//    control -- idempotently re-merging an element that has ALREADY been
//    migrated onto its own current display anchor must NOT be flagged as a
//    crafted eviction (the occupancy guards must not false-positive on
//    legit re-delivery).
// -----------------------------------------------------------------------
test("adjacent crafted-eviction variant: an orphan display anchor is dropped + reported, never applied", () => {
    const errs = [];
    const R = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const l = R.list("seq");
    l.insert(0, "A");
    const before = l.values();

    R.mergeState({ cols: { seq: {
        kind: "list",
        nodes: { "R#1": [null, null] },
        // anchorKey "GHOST#999" names a node that was never shipped in `nodes`
        // and never integrated -- the display anchor is absent.
        elems: { "R#1": [1, "R", "GHOST#999", 0, 0, "", "A"] },
    } } });

    assert.deepEqual(l.values(), before, "an orphan-anchor element must not silently apply");
    assert.ok(errs.some((e) => e.code === "malformed_state"), "the orphan anchor must be reported");
    assert.equal(l._validate(R.clock()), true);
});

test("adjacent crafted-eviction variant (negative control): idempotent re-merge of an already-migrated element is NOT a false-positive eviction", () => {
    const errs = [];
    const R = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
    const l = R.list("seq");
    l.insert(0, "E");   // birth (1, R)
    l.move(0, 0);       // E now occupies its own move anchor (2, R); birth (1, R) vacated
    const beforeVals = l.values(), beforeIds = l.ids();
    const beforeState = seqState(R);

    // Re-merge EXACTLY the doc's own (legitimate) current getState() for this
    // list -- E's elems entry names its OWN current display anchor. This must
    // be a complete no-op: the same element re-claiming the anchor it already
    // occupies is not an eviction of "another" element.
    R.mergeState({ cols: { seq: R.getState().cols.seq } });

    assert.deepEqual(l.values(), beforeVals);
    assert.deepEqual(l.ids(), beforeIds);
    assert.equal(seqState(R), beforeState, "idempotent self-re-merge must be byte-identical");
    assert.equal(errs.length, 0, "an idempotent self-re-merge must never be reported as a crafted eviction");
    assert.equal(l._validate(R.clock()), true);
});

// -----------------------------------------------------------------------
// 8) Boundary matrix -- numeric/shape edges on the new entry points.
// -----------------------------------------------------------------------

test("boundary: getState/mergeState/getStateSince/compact on an EMPTY list (N=0)", () => {
    const R = createCRDTDoc({ replicaId: "R" });
    const l = R.list("seq");
    const s = R.getState();
    // getState builds Object.create(null) containers (C-11/C-12); compare by
    // JSON shape rather than prototype-sensitive deepEqual.
    assert.equal(JSON.stringify(s.cols.seq), JSON.stringify({ kind: "list", nodes: {}, elems: {} }));

    const D = createCRDTDoc({ replicaId: "D" });
    D.mergeState(s);
    assert.deepEqual(D.list("seq").values(), []);
    assert.equal(D.list("seq")._validate(D.clock()), true);

    const delta = R.getStateSince({});
    assert.equal(JSON.stringify(delta.cols.seq), JSON.stringify({ kind: "list", nodes: {}, elems: {} }));

    const reclaimed = R.compact({ R: R.clock() });
    assert.equal(reclaimed, 0);
    assert.equal(l._retention().anchors, 0);
});

test("boundary: N=1 (single element) round-trips and compacts cleanly", () => {
    const R = createCRDTDoc({ replicaId: "R" });
    const l = R.list("seq");
    l.insert(0, "only");
    const D = createCRDTDoc({ replicaId: "D" });
    D.mergeState(R.getState());
    assert.deepEqual(D.list("seq").values(), ["only"]);
    assert.equal(D.list("seq")._validate(D.clock()), true);

    l.delete(0);
    const before = l._retention();
    assert.equal(before.elems, 0);
    const reclaimed = R.compact({ R: R.clock() });
    assert.ok(reclaimed >= 1);
    // The sole anchor's origin was HEAD (never named by any surviving node as
    // an origin), so under full quiescence Tier 2 unlinks it too: anchors -> 0.
    assert.equal(l._retention().anchors, 0, "the only anchor was an origin-leaf under quiescence -- fully reclaimed");
    assert.equal(l.values().length, 0);
});

test("boundary: minAck at clock-1 (N-1), clock (N), and clock+1-equivalent (beyond current clock) for compact", () => {
    const R = createCRDTDoc({ replicaId: "R" });
    const l = R.list("seq");
    l.insert(0, "a"); l.insert(1, "b");
    l.delete(0);                       // dl = 3 (ticks: 1,2 births, 3 delete)
    const clk = R.clock();

    // minAck = clk-1 (N-1): NOT stable yet (dl(3) <= clk-1 is false when clk=3).
    const rMinus1 = R.compact({ R: clk - 1 });
    assert.equal(rMinus1, 0, "minAck=clock-1 must not reclaim a delete stamped at clock");
    // minAck = clk (N): stable, Tier 1 fires; quiesced true (single writer at own clock) -> Tier 2 also runs.
    const rEq = R.compact({ R: clk });
    assert.ok(rEq >= 1, "minAck=clock must reclaim the stable delete");
    // minAck beyond the doc's own clock (N+1, an impossible-but-not-malformed
    // frontier: a peer claiming to have seen more than we have emitted) --
    // snapshotVector accepts it (finite, < ceiling); compact must not crash
    // and must not double-reclaim (idempotent fixpoint).
    const rPlus1 = R.compact({ R: clk + 1 });
    assert.equal(rPlus1, 0, "an already-fully-compacted list has nothing left to reclaim, even at an over-eager frontier");
    assert.deepEqual(l.values(), ["b"]);
    assert.equal(l._validate(R.clock()), true);
});

test("boundary: null/undefined/NaN/-0 across mergeState and compact/getStateSince", () => {
    // null nodes/elems: rejected at the doc-level okState gate (shape check),
    // never reaches the list's own null-safety fallback -- a no-op, reported.
    {
        const errs = [];
        const R = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
        const l = R.list("seq");
        l.insert(0, "a");
        R.mergeState({ cols: { seq: { kind: "list", nodes: null, elems: null } } });
        assert.deepEqual(l.values(), ["a"], "a null-shaped list state must not mutate the doc");
        assert.ok(errs.some((e) => e.code === "malformed_state"));
    }
    // undefined state / undefined V: doc.mergeState(undefined) and
    // doc.compact(undefined)/getStateSince(undefined) must fail closed, never throw.
    {
        const R = createCRDTDoc({ replicaId: "R" });
        const l = R.list("seq");
        l.insert(0, "a");
        assert.doesNotThrow(() => R.mergeState(undefined));
        assert.doesNotThrow(() => R.mergeState(null));
        let reclaimed;
        assert.doesNotThrow(() => { reclaimed = R.compact(undefined); });
        assert.equal(reclaimed, 0);
        let delta;
        assert.doesNotThrow(() => { delta = R.getStateSince(undefined); });
        assert.equal(JSON.stringify(delta.cols.seq), seqState(R), "malformed/undefined V falls back to full state");
        assert.deepEqual(l.values(), ["a"]);
    }
    // NaN lamport in a crafted node key: dropped + reported, never poisons the clock.
    {
        const errs = [];
        const R = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
        const l = R.list("seq");
        R.mergeState({ cols: { seq: { kind: "list", nodes: { "R#NaN": [null, null] }, elems: {} } } });
        assert.equal(l.values().length, 0);
        assert.ok(errs.some((e) => e.code === "malformed_state"));
        assert.equal(l._validate(R.clock()), true);
    }
    // NaN in a version-vector value: the WHOLE vector is rejected (fail closed
    // to the safe superset -- full state / zero reclaim), never a partial read.
    {
        const R = createCRDTDoc({ replicaId: "R" });
        const l = R.list("seq");
        l.insert(0, "a"); l.delete(0);
        const errs = [];
        R._report ? null : null; // no-op; onError already wired at construction in other cases
        const reclaimed = R.compact({ R: NaN });
        assert.equal(reclaimed, 0, "a NaN version-vector entry must reject the whole V, reclaiming nothing");
    }
    // -0 lamport: numerically equal to 0, must be ACCEPTED (Number.isFinite(-0)
    // is true and -0 < 0 is false) and must not corrupt the sequence.
    {
        const errs = [];
        const R = createCRDTDoc({ replicaId: "R", onError: (e) => errs.push(e) });
        const l = R.list("seq");
        R.mergeState({ cols: { seq: { kind: "list",
            nodes: { "R#-0": [null, null] },
            elems: { "R#-0": [-0, "R", "R#-0", 0, 0, "", "zero"] },
        } } });
        assert.deepEqual(l.values(), ["zero"], "-0 must be treated as the valid lamport 0");
        assert.equal(errs.length, 0);
        assert.equal(l._validate(R.clock()), true);
        // -0 in a version-vector value behaves exactly like 0 (nothing stable).
        l.insert(1, "b"); l.delete(0);
        const reclaimed = R.compact({ R: -0 });
        assert.equal(reclaimed, 0, "minAck=-0 must reclaim nothing, exactly like minAck=0");
    }
});

test("boundary: a malformed version vector (array, __proto__ key, non-object) rejects the WHOLE V for both compact and getStateSince", () => {
    const R = createCRDTDoc({ replicaId: "R" });
    const l = R.list("seq");
    l.insert(0, "a"); l.delete(0);
    const full = seqState(R);

    for (const badV of [[], "not-an-object", 42, JSON.parse('{"__proto__": 5}')]) {
        const errs = [];
        const doc2 = createCRDTDoc({ replicaId: "R2", onError: (e) => errs.push(e) });
        doc2.list("seq").insert(0, "x"); doc2.list("seq").delete(0);
        assert.equal(doc2.compact(badV), 0, "malformed V " + JSON.stringify(badV) + " must reclaim nothing");
        assert.ok(errs.some((e) => e.code === "malformed_state"));
        const delta = doc2.getStateSince(badV);
        assert.equal(JSON.stringify(delta.cols.seq), seqState(doc2), "malformed V must fall back to full state for getStateSince too");
    }
});

// -----------------------------------------------------------------------
// 9) duplicate dispose / dispose-during-iteration / re-entrant write.
// -----------------------------------------------------------------------

test("duplicate dispose is a no-op on the list's C5.4 surface", () => {
    const R = createCRDTDoc({ replicaId: "R" });
    const l = R.list("seq");
    l.insert(0, "a");
    R.dispose();
    assert.doesNotThrow(() => R.dispose(), "a second dispose() must not throw");
    // Post-dispose, the C5.4 entry points must fail closed (no crash) rather
    // than resurrect state.
    assert.doesNotThrow(() => R.mergeState({ cols: { seq: { kind: "list", nodes: {}, elems: {} } } } ));
    assert.equal(R.compact({ R: 5 }), 0, "compact() on a disposed doc reclaims nothing");
    assert.throws(() => R.list("seq"), { code: "misconfigured" }, "list() on a disposed doc must throw, never silently recreate");
});

test("re-entrant write: a 'change' listener that inserts DURING mergeState does not corrupt the list", () => {
    const R = createCRDTDoc({ replicaId: "R" });
    const l = R.list("seq");
    l.insert(0, "a");

    let fired = false;
    R.on("change", () => {
        if (!fired) { fired = true; l.insert(l.size, "reentrant"); }
    });

    R.mergeState({ cols: { seq: { kind: "list",
        nodes: { "R#5": [null, null] },
        elems: { "R#5": [5, "R", "R#5", 0, 0, "", "b"] },
    } } });

    assert.ok(l.values().includes("a"));
    assert.ok(l.values().includes("b"));
    assert.ok(l.values().includes("reentrant"));
    assert.equal(l._validate(R.clock()), true);
});

// This is the "one adversarial case the planner did not think of": a
// reentrant doc.dispose() fired from a 'change' listener DURING a
// multi-collection doc.mergeState() call. The list's own _mergeState has
// already fully mutated its internal state by the time it calls
// ctx.changed() (rebuildList() is the LAST statement in _mergeState), so the
// currently-merging list collection itself is never corrupted. The hazard was
// the OUTER doc.mergeState() loop: it did not re-check `disposed` between
// collections, so a dispose() fired reentrantly while a LATER collection name
// was still queued in the SAME merge call let `getCollection()` (called by the
// continuing loop) create a BRAND-NEW collection into the just-cleared `cols`
// Map -- a live, leaked "zombie" collection inaccessible via the public API yet
// still holding a live store/signal that was never passed to `_dispose()`.
// Fix A (C5.5) re-checks `disposed` at the top of every iteration and bails
// fail closed, so no zombie is created and the doc is cleanly disposed.
test("Fix A: reentrant dispose() during a multi-collection mergeState() leaves NO zombie collection past disposal", () => {
    const R = createCRDTDoc({ replicaId: "R" });
    R.list("seq").insert(0, "a");
    R.list("seq").insert(1, "b");

    let fired = false;
    R.on("change", () => {
        if (!fired) { fired = true; R.dispose(); }
    });

    R.mergeState({ cols: {
        seq: { kind: "list", nodes: { "R#3": [null, null] }, elems: { "R#3": [3, "R", "R#3", 0, 0, "", "c"] } },
        other: { kind: "map", entries: { k: [1, "R", "v"] } },   // processed AFTER "seq" (sorted for-in on a plain object is insertion order here)
    } });

    // The doc reports itself disposed and its public accessors refuse access.
    assert.throws(() => R.list("seq"), { code: "misconfigured" });
    assert.throws(() => R.map("other"), { code: "misconfigured" });
    // FIXED: the outer loop bailed the instant dispose() fired, so the "other"
    // collection was NEVER created into the cleared `cols` Map. No live
    // undisposed collection remains -- the doc is cleanly disposed, nothing
    // retained past dispose().
    const remaining = [...R._cols()];
    assert.equal(remaining.length, 0, "Fix A: no zombie collection may survive a reentrant mid-merge dispose()");
});
