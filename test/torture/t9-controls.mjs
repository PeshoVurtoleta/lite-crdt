/**
 * T9 -- controls. Every gate the suite relies on, deliberately broken, must be
 * caught here. If a control slips through, T9 fails the whole run -- a gate that
 * cannot fail is decoration.
 */
import { createCRDTDoc } from "../../CRDT.js";
import { runOpsGate, validate, canon, die } from "./harness.mjs";

// Build a fresh list doc, apply `ops` in order, return the visible id-order as a
// string, then dispose. Used to compare delivery orders / broken variants.
function renderIds(ops) {
    const d = createCRDTDoc({ replicaId: "C" });
    const l = d.list("s");
    for (const op of ops) d.applyOp(op);
    const r = JSON.stringify(l.ids());
    d.dispose();
    return r;
}

export function run() {
    // Control 1 -- the zero-alloc gate must REJECT a retained-allocation loop.
    const leak = [];
    const g = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
    if (g.report.ok) die("T9 control 1: an allocating hot loop passed the zero-alloc gate");
    leak.length = 0;

    // Control 2 -- validate() must THROW on a non-finite clock. The applyOp
    // l:Infinity vector that poisoned a real doc in v1.1.1 is now closed by the
    // door, so validate() is fed a stub whose clock() is non-finite (validate
    // only calls doc.clock() and doc.getState()); it must still bite.
    const nonFinite = { clock: () => Infinity, getState: () => ({ cols: {} }) };
    let caught = false;
    try { validate(nonFinite); } catch { caught = true; }
    if (!caught) die("T9 control 2: validate() passed a doc with a non-finite clock");

    // Control 3 -- the convergence equality is NON-VACUOUS: two docs fed
    // genuinely different logs must produce different canonical snapshots, so a
    // convergence check that compares them would actually fail.
    const a = createCRDTDoc({ replicaId: "A" });
    const b = createCRDTDoc({ replicaId: "B" });
    a.applyOp({ t: "set", c: "m", k: "k", l: 1, r: "A", v: "one" });
    b.applyOp({ t: "set", c: "m", k: "k", l: 2, r: "B", v: "two" });
    if (canon(a) === canon(b)) die("T9 control 3: divergent docs compared equal (convergence gate is vacuous)");
    a.dispose(); b.dispose();

    // ====================================================================
    // The five RGA controls (ASSERTION 6). Each proves a load-bearing list
    // gate is NON-VACUOUS: a deliberately-broken behaviour is exhibited and
    // the gate's own comparison is shown to catch it -- if it does not, the
    // control die()s and the whole torture run prints FAIL, not `ok`.
    // ====================================================================

    // RGA-1 -- the origin-tie comparator DIRECTION is load-bearing. Two
    // concurrent HEAD inserts (1,"A") and (2,"B") must order DESCENDING by
    // (lamport, replicaId): the higher stamp (2,"B") comes first -> ["b","a"].
    // A comparator with `>` flipped to `<` in the integrate scan would yield
    // the ascending ["a","b"]. If the real render EQUALS the ascending order,
    // the tie direction is not being exercised -- the gate is vacuous.
    const tieDoc = createCRDTDoc({ replicaId: "T" });
    const tieL = tieDoc.list("s");
    tieDoc.applyOp({ t: "lins", c: "s", l: 1, r: "A", or: null, v: "a" });
    tieDoc.applyOp({ t: "lins", c: "s", l: 2, r: "B", or: null, v: "b" });
    const tieReal = JSON.stringify(tieL.values());
    const tieAscending = JSON.stringify(["a", "b"]);   // what a flipped comparator produces
    if (tieReal === tieAscending) die("T9 rga-1: concurrent same-origin ties do not descend by (lamport, replicaId) -- a flipped integrate comparator would pass this gate");
    if (tieReal !== JSON.stringify(["b", "a"])) die("T9 rga-1: descending-tie order is not the expected [b,a] (got " + tieReal + ")");
    tieDoc.dispose();

    // RGA-2 -- MOVE convergence rests on the tsWins guard. Two concurrent
    // moves of one element to DIFFERENT destinations: the higher-stamp move
    // (11,"B") must win regardless of delivery order. A move applied WITHOUT
    // the guard is last-write-wins -> order-dependent -> divergent.
    const seq = [
        { t: "lins", c: "s", l: 1, r: "Z", or: null, v: "z0" },
        { t: "lins", c: "s", l: 2, r: "Z", or: "Z", ol: 1, v: "z1" },
        { t: "lins", c: "s", l: 3, r: "Z", or: "Z", ol: 2, v: "z2" },
    ];
    const mvLo = { t: "lmv", c: "s", l: 10, r: "A", bl: 1, br: "Z", or: "Z", ol: 3 };   // E0 -> after E2
    const mvHi = { t: "lmv", c: "s", l: 11, r: "B", bl: 1, br: "Z", or: "Z", ol: 2 };   // E0 -> after E1
    const soloLo = renderIds(seq.concat([mvLo]));
    const soloHi = renderIds(seq.concat([mvHi]));
    if (soloLo === soloHi) die("T9 rga-2: the two move destinations are indistinguishable -- the control is not discriminating");
    const both1 = renderIds(seq.concat([mvLo, mvHi]));
    const both2 = renderIds(seq.concat([mvHi, mvLo]));
    if (both1 !== both2) die("T9 rga-2: concurrent moves diverged across delivery order -- the tsWins move guard is missing (a no-guard move is last-write-wins)");
    if (both1 !== soloHi) die("T9 rga-2: the higher-stamp move did not win (tsWins picked the wrong register)");

    // RGA-3 -- an out-of-order insert must PEND, never be dropped. Deliver a
    // child insert (origin P) BEFORE its origin P: the real doc holds it and
    // converges to include it. A broken impl that DROPS an unknown-origin
    // insert would render the drop outcome (origin only). If the pended render
    // equals the drop render, the reorder scenario is vacuous.
    const parent = { t: "lins", c: "s", l: 1, r: "P", or: null, v: "p" };
    const child = { t: "lins", c: "s", l: 2, r: "P", or: "P", ol: 1, v: "c" };
    const pended = renderIds([child, parent]);   // child first: real doc pends, then drains
    const dropped = renderIds([parent]);          // what a drop-on-unknown-origin impl keeps
    if (pended === dropped) die("T9 rga-3: a reordered insert made no difference -- the pending-not-drop gate is vacuous");
    if (pended !== renderIds([parent, child])) die("T9 rga-3: reordered delivery did not converge to the in-order render (pending buffer broken)");

    // RGA-4 -- Tier-2 anchor unlink is sound ONLY under the origin-leaf guard
    // (CRDT.js: the `!referenced.has(...)` clause). This control drives the REAL
    // compact() path so it actually tests that clause: a live element `e1` whose
    // ORIGIN anchor `S#1` is an unoccupied tombstone (its birth element `e0` was
    // deleted and Tier-1-reclaimed). A QUIESCENT compact must KEEP `S#1` (a
    // surviving node still names it as origin); if Tier-2 unlinks it, the next
    // getState() ships `e1` with a dangling origin and a peer's mergeState()
    // ORPHAN-DROPS it -- silent data loss (peer renders [] instead of ["e1"]).
    // die() if the live element is lost on the peer round-trip.
    const s4 = createCRDTDoc({ replicaId: "S" });
    const sl4 = s4.list("s");
    sl4.insert(0, "e0");             // birth S#1 (origin HEAD)
    sl4.insert(1, "e1");             // birth S#2 (origin S#1) -- e1 names S#1 as origin
    sl4.delete(0);                   // delete e0; S#1 becomes an unoccupied tombstone
    // A single-writer quiescent frontier: minAck == maxAck == clock, so Tier-2 runs.
    s4.compact(s4.versionVector());  // Tier-1 reclaims e0's record; Tier-2 MUST keep S#1 (origin of live e1)
    const doc4Render = JSON.stringify(sl4.values());
    if (doc4Render !== JSON.stringify(["e1"])) die("T9 rga-4: compaction changed the live sequence (expected [\"e1\"], got " + doc4Render + ")");
    // The load-bearing check: round-trip the compacted state to a FRESH peer.
    const peer4 = createCRDTDoc({ replicaId: "P4", onError: () => {} });
    peer4.mergeState(s4.getState());
    const peer4Render = JSON.stringify(peer4.list("s").values());
    if (peer4Render !== doc4Render) die("T9 rga-4: a live element was LOST on the peer round-trip after Tier-2 compaction (peer=" + peer4Render + " doc=" + doc4Render + ") -- the origin-leaf guard unlinked an anchor a surviving node still names as origin");
    s4.dispose(); peer4.dispose();

    // RGA-5 -- an allocating list-apply path must trip the zero-alloc gate the
    // T6 list redelivery relies on. Gate a loop that applies a redelivered
    // (idempotent) list op AND allocates per call: the gate MUST reject it.
    const ad = createCRDTDoc({ replicaId: "AL" });
    const al = ad.list("s");
    al.insert(0, 0);
    const redeliver = { t: "lins", c: "s", l: 1, r: "AL", or: null, v: 0 };   // idempotent (already present)
    const sink = [];
    const ga = runOpsGate((i) => { ad.applyOp(redeliver); sink.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
    if (ga.report.ok) die("T9 rga-5: an allocating list-apply path passed the zero-alloc gate");
    sink.length = 0;
    ad.dispose();
}
