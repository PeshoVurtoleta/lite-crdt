/**
 * T7 -- soak, retention, conservation. Build-up / tear-down cycles over merge
 * traffic. After each cycle: validate(doc) passes and dispose() leaves nothing
 * retained (a lite-leak witness -- a second, independent signal from the heap
 * gate: a leaked JS object and a leaked signal node cannot mask each other).
 *
 * The retention BOUND (C-10: the live `adds` map is O(live ids), not O(ops)) is
 * asserted here as of C2: after a bounded id set is churned through many
 * add/delete cycles, the number of `adds` entries never exceeds the live-id
 * count -- an emptied id's dead tag Map is dropped, not retained. valueReg is
 * deliberately KEPT (it carries the LWW max-lamport register; dropping it would
 * diverge -- see decisions/0002).
 */
import { createLeakTracker } from "@zakkster/lite-leak";
import { createCRDTDoc } from "../../CRDT.js";
import { SEED, makePrng, frac, check, validate, canon } from "./harness.mjs";
import { drive } from "./corpus.mjs";

const CYCLES = Math.max(1, Number(process.env.TORTURE_CYCLES) || 200);

export function run() {
    const tracker = createLeakTracker({ name: "lite-crdt-soak" });

    for (let cycle = 0; cycle < CYCLES; cycle++) {
        const log = drive(SEED + 5000 + cycle, { replicas: 2, rounds: 8, opsPerRound: 5 });
        const d = createCRDTDoc({ replicaId: "SOAK" });
        const handle = tracker.track(d, () => d.dispose(), "doc");
        for (const op of log) d.applyOp(op);
        validate(d);
        // tear down: dispose must release everything this cycle allocated.
        d.dispose();
        tracker.untrack(handle);
    }

    check(tracker.size() === 0, () => `T7: leak tracker retained ${tracker.size()} docs after ${CYCLES} dispose cycles`);

    // Door-specific retention witness: 4096 apply/reject cycles (every cycle
    // feeds one good op AND one poison op through the door, so the reject path
    // itself is exercised, not just the happy path) must leave nothing tracked
    // once every doc is disposed -- no retention across the reject-and-continue
    // door (a rejected op's report()/onError closure must not pin the doc).
    const DOOR_CYCLES = 4096;
    const doorTracker = createLeakTracker({ name: "lite-crdt-door-soak" });
    for (let i = 0; i < DOOR_CYCLES; i++) {
        const d = createCRDTDoc({ replicaId: "DOOR", onError: () => {} });
        const handle = doorTracker.track(d, () => d.dispose(), "door-doc");
        d.map("m").set("k", i);                                            // good
        d.applyOp({ t: "set", c: "m", k: "k", l: Infinity, r: "evil", v: -1 }); // reject
        d.applyOp({ t: "cinc", c: "c", r: "evil", p: "999" });              // reject
        d.dispose();
        doorTracker.untrack(handle);
    }
    check(doorTracker.size() === 0, () => `T7: leak tracker retained ${doorTracker.size()} docs after ${DOOR_CYCLES} apply/reject cycles`);

    // Retention soak (C-10): churn a BOUNDED id set through many add/delete
    // cycles. Each delete empties an id's tag Map; that dead entry must be
    // dropped, so `adds` stays O(live ids) -- never O(cycles). If the empty entry
    // leaked, adds size would climb toward RETAIN_CYCLES instead of <= ID_COUNT.
    const RETAIN_CYCLES = 4096;
    const ID_COUNT = 16;
    const rprng = makePrng(SEED ^ 0x5a17);
    const rd = createCRDTDoc({ replicaId: "RETAIN" });
    const arr = rd.array("bag");
    for (let i = 0; i < RETAIN_CYCLES; i++) {
        const id = "id" + (Math.floor(frac(rprng) * ID_COUNT));
        // add then (usually) delete the same id: an emptied id must drop its
        // adds entry, while its value register legitimately persists.
        arr.add({ id, v: i });
        if (frac(rprng) < 0.75) arr.deleteById(id);
    }
    // The internal probe (not getState -- getState filters emptied tag Maps out):
    // `adds` must equal the live member count, so no dead empty entry lingers.
    const r = arr._retention();
    check(r.adds === arr.size, () => `T7: adds map holds ${r.adds} entries but only ${arr.size} ids are live (${r.adds - arr.size} dead empty entries -- C-10 leak)`);
    check(r.adds <= ID_COUNT, () => `T7: adds map grew to ${r.adds} over ${ID_COUNT} ids after ${RETAIN_CYCLES} cycles (retention is not O(live ids))`);
    check(r.valueReg <= ID_COUNT, () => `T7: valueReg grew to ${r.valueReg} over ${ID_COUNT} ids (should be one register per distinct id)`);
    validate(rd);
    rd.dispose();

    // C-14 re-baseline: the WIDENED auto-minted replicaId (34 chars: "r-" + 32
    // hex) lengthens every tagKey (`replicaId + "#" + n`) it stamps. Re-run the
    // retention soak on a doc created WITHOUT a caller replicaId so the wider id
    // genuinely feeds the tag path, and confirm the retention bound is
    // WIDTH-INDEPENDENT: `adds` is still O(live ids), never O(cycles), no matter
    // how long the id is. The RETAIN soak above uses a short caller id ("RETAIN");
    // this one proves the wider default does not change the invariant.
    const wd = createCRDTDoc();                 // auto-mint the id
    // OLD id width was ~10 chars ("r-" + 8 hex), tagKey ~ 12 bytes; NEW id width
    // is 34 chars, tagKey ~ 36 bytes. Pin the NEW width so a silent narrowing of
    // genReplicaId (a uniqueness regression) fails here.
    const ID_WIDTH = 34;
    check(wd.replicaId.length === ID_WIDTH, () => `T7: auto-minted replicaId width is ${wd.replicaId.length}, expected ${ID_WIDTH} (genReplicaId narrowed -- uniqueness regression)`);
    const warr = wd.array("wbag");
    const wprng = makePrng(SEED ^ 0x71d7);
    for (let i = 0; i < RETAIN_CYCLES; i++) {
        const id = "id" + (Math.floor(frac(wprng) * ID_COUNT));
        warr.add({ id, v: i });
        if (frac(wprng) < 0.75) warr.deleteById(id);
    }
    const wr = warr._retention();
    check(wr.adds === warr.size, () => `T7: (wide id) adds holds ${wr.adds} entries but ${warr.size} ids are live (${wr.adds - warr.size} dead empty entries -- C-10 leak)`);
    check(wr.adds <= ID_COUNT, () => `T7: (wide id) adds grew to ${wr.adds} over ${ID_COUNT} ids after ${RETAIN_CYCLES} cycles (retention not O(live ids) -- width leaked into growth)`);
    // Every live tagKey is exactly one id-width + "#" + a decimal counter, so the
    // per-tag byte cost is bounded by the id width, not the cycle count. The
    // widened id costs ~24 extra bytes PER LIVE TAG (a memory cost), never a
    // per-op allocation (T6 proves apply stays zero-alloc).
    validate(wd);
    wd.dispose();

    // C4 compaction soak: churn a BOUNDED live id set through a large add/delete
    // workload on TWO docs stepped in lock-step -- one compacts at its own frontier
    // (single writer, so its versionVector() IS the global min), the other never
    // compacts. The compacting doc's tombstone census must fall to O(live ids); the
    // uncompacted control's grows O(ops). Observable state stays identical, and the
    // leak witness returns to 0 after dispose (decisions/0004).
    const CHURN = 20000;
    const CID = 24;
    const compactTracker = createLeakTracker({ name: "lite-crdt-compact-soak" });
    const cprng = makePrng(SEED ^ 0xc0117ac7);
    const comp = createCRDTDoc({ replicaId: "COMP" });
    const ctrl = createCRDTDoc({ replicaId: "COMP" });          // same id -> identical op stream
    const compH = compactTracker.track(comp, () => comp.dispose(), "comp");
    const ctrlH = compactTracker.track(ctrl, () => ctrl.dispose(), "ctrl");
    const compArr = comp.array("bag"), ctrlArr = ctrl.array("bag");
    const compMap = comp.map("kv"), ctrlMap = ctrl.map("kv");
    for (let i = 0; i < CHURN; i++) {
        const id = "id" + (Math.floor(frac(cprng) * CID));
        const k = "k" + (Math.floor(frac(cprng) * CID));
        const del = frac(cprng) < 0.7;
        const mdel = frac(cprng) < 0.5;
        compArr.add({ id, v: i }); ctrlArr.add({ id, v: i });
        if (del) { compArr.deleteById(id); ctrlArr.deleteById(id); }
        compMap.set(k, i); ctrlMap.set(k, i);
        if (mdel) { compMap.delete(k); ctrlMap.delete(k); }
        if ((i & 4095) === 4095) comp.compact(comp.versionVector());   // periodic reclamation
    }
    comp.compact(comp.versionVector());

    const compRem = compArr._retention().removed;
    const ctrlRem = ctrlArr._retention().removed;
    check(compRem <= CID, () => `T7/C4: compacted removed census ${compRem} exceeds the live id bound ${CID}`);
    check(compArr._retention().valueReg <= CID, () => `T7/C4: compacted valueReg ${compArr._retention().valueReg} exceeds the live id bound ${CID}`);
    check(ctrlRem > compRem, () => `T7/C4: uncompacted control census ${ctrlRem} is not larger than the compacted ${compRem}`);
    check(ctrlRem > CID, () => `T7/C4: uncompacted control census ${ctrlRem} should be O(ops), far above the live id bound ${CID}`);
    // Observable convergence is untouched by compaction.
    check(canon(comp) === canon(ctrl), () => "T7/C4: compaction changed the observable snapshot vs the uncompacted control");
    validate(comp); validate(ctrl);

    comp.dispose(); ctrl.dispose();
    compactTracker.untrack(compH); compactTracker.untrack(ctrlH);
    check(compactTracker.size() === 0, () => `T7/C4: leak tracker retained ${compactTracker.size()} docs after the compaction soak`);

    // -- C5.5 RGA list retention/compaction soak (ASSERTION 4) ---------------
    // ~20000-op churn over ~64 live elements on two lock-stepped docs: `lcomp`
    // compacts periodically and once finally under proven quiescence; `lctrl` is
    // fed the identical op stream and NEVER compacts. After the quiescent compact
    // Tier-2 must have unlinked every unjustified unoccupied anchor (reclaimable
    // == 0) so lcomp's anchor census settles to the size+1+U bound; the control's
    // grows O(ops). The visible sequence is byte-identical, and replaying the
    // whole log after compaction resurrects nothing (decisions/0004 + 0006).
    const LCHURN = 20000;
    const LIVE = 64;
    const lprng = makePrng(SEED ^ 0x115700);
    const lpick = (n) => Math.floor(frac(lprng) * n);
    const lcomp = createCRDTDoc({ replicaId: "LCOMP" });
    const lctrl = createCRDTDoc({ replicaId: "LCOMP" });   // same id -> identical stream when fed lcomp's ops
    const lcompList = lcomp.list("bag");
    const lctrlList = lctrl.list("bag");
    const lLog = [];
    lcomp.on("op", (op) => lLog.push(op));
    for (let i = 0; i < LCHURN; i++) {
        const size = lcompList.size;
        // Keep the live set near LIVE: grow when small, churn (delete/move) when full.
        let kind;
        if (size === 0) kind = 0;
        else if (size < LIVE) kind = (lpick(4) === 0 && size > 1) ? 2 : 0;   // mostly insert, occasional move
        else kind = lpick(2) === 0 ? 1 : (size > 1 ? 2 : 1);                 // delete or move
        if (kind === 0) lcompList.insert(lpick(size + 1), i);
        else if (kind === 1) lcompList.delete(lpick(size));
        else lcompList.move(lpick(size), lpick(size));
        if ((i & 4095) === 4095) lcomp.compact(lcomp.versionVector());       // periodic reclamation
    }
    for (const op of lLog) lctrl.applyOp(op);                               // feed control the identical stream
    // Final reclamation: compact to a FIXPOINT. Tier-2 unlink is progressive and
    // cascade-free per call -- a chain of dead tombstone anchors drains one leaf
    // layer per pass (removing a leaf exposes its predecessor next pass), because
    // a single pass must never dangle a still-referenced origin (the origin-leaf
    // guard). Iterating to reclaimed == 0 drives every UNREFERENCED dead anchor
    // out; what remains is only JUSTIFIED (decisions/0006).
    let lpasses = 0, lrec;
    do { lrec = lcomp.compact(lcomp.versionVector()); lpasses++; } while (lrec > 0 && lpasses < 400);

    const cr = lcompList._retention();
    const kr = lctrlList._retention();
    const lsize = lcompList.size;
    // At the fixpoint every unjustified unoccupied anchor is reclaimed.
    check(cr.reclaimable === 0, () => `T7/list: compacted list left ${cr.reclaimable} unjustified unoccupied anchors at the compaction fixpoint (${lpasses} passes) -- Tier-2 did not fully reclaim`);
    // The confirmed bound: anchors <= size + 1 + U (U = justified unoccupied =
    // still-live moved-element birth homes + origin-referenced anchors). With
    // reclaimable == 0 the census is exactly `size + justified`.
    check(cr.anchors <= lsize + 1 + cr.justified, () => `T7/list: compacted anchors ${cr.anchors} exceed the size+1+U bound (${lsize}+1+${cr.justified})`);
    // U is O(live), never O(ops): far below the churn count.
    check(cr.justified <= 12 * LIVE, () => `T7/list: justified unoccupied anchors ${cr.justified} not O(live) (bound ${12 * LIVE}, churn ${LCHURN})`);
    check(cr.anchors < 2000, () => `T7/list: compacted anchor census ${cr.anchors} is not O(live) (churn ${LCHURN})`);
    check(cr.elems === lsize, () => `T7/list: elems ${cr.elems} !== size ${lsize}`);
    // The uncompacted control retains O(ops) anchors and dead tombstones.
    check(kr.reclaimable > 2000, () => `T7/list: uncompacted control kept only ${kr.reclaimable} reclaimable anchors (expected O(ops) over ${LCHURN} churn)`);
    check(kr.anchors > cr.anchors, () => `T7/list: control anchors ${kr.anchors} not larger than compacted ${cr.anchors}`);
    check(kr.anchors > 5000, () => `T7/list: control anchors ${kr.anchors} should be O(ops)`);
    // Observable convergence untouched by compaction.
    check(canon(lcomp) === canon(lctrl), () => "T7/list: compaction changed the observable snapshot vs the uncompacted control");
    validate(lcomp); validate(lctrl);
    // Over-reclamation guard (origin-leaf): serialize the compacted doc and merge
    // it into a FRESH peer. If Tier-2 unlinked an anchor a surviving node still
    // names as origin, that node ships with a dangling origin and the peer
    // orphan-drops the live element -- a peer render that differs from the source
    // is silent data loss. This catches over-reclamation the same-doc replay
    // cannot (defense in depth with T9 rga-4).
    const lpeer = createCRDTDoc({ replicaId: "LPEER" });
    lpeer.mergeState(lcomp.getState());
    check(canon(lpeer) === canon(lcomp), () => "T7/list: compacted state lost a live element on a fresh-peer getState -> mergeState round-trip (Tier-2 over-reclaimed a still-referenced origin anchor)");
    validate(lpeer);
    lpeer.dispose();
    // No compacted anchor resurrects: replaying the whole log after compaction
    // leaves the render unchanged.
    const lCanonBefore = canon(lcomp);
    for (const op of lLog) lcomp.applyOp(op);
    check(canon(lcomp) === lCanonBefore, () => "T7/list: replaying the full log after compaction resurrected a reclaimed anchor");
    validate(lcomp);
    lcomp.dispose(); lctrl.dispose();
}
